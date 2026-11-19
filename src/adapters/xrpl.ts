import { Client, Wallet, decodeSeed, dropsToXrp, type ECDSA, type Payment, type TxResponse } from "xrpl";
import type { ChainAdapter, ChainStatus } from "./chain.js";
import type { TxRef } from "../domain/record.js";
import { payloadSize } from "../domain/hash.js";
import {
  XRPL_MEMOS_MAX_BYTES,
  decodeAnchorMemo,
  decodeRecordMemo,
  encodeAnchorMemo,
  encodeRecordMemo,
  memoSizeBytes,
  type AnchorMemoData,
  type XrplMemo,
} from "./xrplMemo.js";

export interface XrplAdapterOptions {
  wsUrl: string;
  seed: string;
  /** Second account of the API that receives the minimal payments that carry the memos. */
  anchorDestination: string;
  maxPayloadBytes: number;
  /**
   * Stand-alone mode: ledgers only close when ledger_accept is called, so the adapter
   * closes the ledger itself after submitting a transaction. Only for local development.
   */
  standalone?: boolean;
  /** Maximum number of account_tx pages read when a record has to be found without the local store. */
  maxHistoryPages?: number;
}

/**
 * Creates a wallet from a seed, using the key algorithm encoded in the seed
 * (seeds starting with "sEd" are Ed25519; the others are secp256k1).
 */
export function walletFromSeed(seed: string): Wallet {
  const type = decodeSeed(seed).type;
  // ECDSA is a TypeScript enum; xrpl is CommonJS, so Node ESM cannot import it as a value.
  const algorithm = (type === "ed25519" ? "ed25519" : "ecdsa-secp256k1") as ECDSA;
  return Wallet.fromSeed(seed, { algorithm });
}

export class PayloadTooLargeError extends Error {
  constructor(size: number, max: number) {
    super(`Payload of ${size} bytes exceeds the limit of ${max} bytes`);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Adapter of the XRP Ledger (FR1). Records are written in the Memos field of a minimal
 * payment from the account of the API to its second account.
 */
export class XrplAdapter implements ChainAdapter {
  readonly name = "xrpl" as const;
  private readonly client: Client;
  private readonly wallet: Wallet;

  constructor(private readonly opts: XrplAdapterOptions, client?: Client) {
    this.client = client ?? new Client(opts.wsUrl);
    this.wallet = walletFromSeed(opts.seed);
  }

  /** Public address of the API account (to be published, SR12). */
  get address(): string {
    return this.wallet.classicAddress;
  }

  async connect(): Promise<void> {
    if (!this.client.isConnected()) await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client.isConnected()) await this.client.disconnect();
  }

  async store(id: string, payload: string): Promise<TxRef> {
    const size = payloadSize(payload);
    if (size > this.opts.maxPayloadBytes) throw new PayloadTooLargeError(size, this.opts.maxPayloadBytes);
    const memo = encodeRecordMemo(id, payload);
    return this.submitMemo(memo);
  }

  /**
   * Submits a payment that carries a memo and returns only when the transaction is in a
   * validated ledger with result tesSUCCESS (SR9). Also used for anchors in T3.4.
   */
  async submitMemo(memo: XrplMemo): Promise<TxRef> {
    if (memoSizeBytes(memo) > XRPL_MEMOS_MAX_BYTES) {
      throw new PayloadTooLargeError(memoSizeBytes(memo), XRPL_MEMOS_MAX_BYTES);
    }
    await this.connect();
    const tx: Payment = {
      TransactionType: "Payment",
      Account: this.wallet.classicAddress,
      Destination: this.opts.anchorDestination,
      Amount: "1", // 1 drop: the payment is only used to carry the memo
      Memos: [memo],
    };
    const prepared = await this.client.autofill(tx);
    const signed = this.wallet.sign(prepared);

    let response: TxResponse;
    if (this.opts.standalone) {
      await this.client.submit(signed.tx_blob);
      await this.client.request({ command: "ledger_accept" } as never);
      response = await this.client.request({ command: "tx", transaction: signed.hash });
    } else {
      // submitAndWait returns when the transaction is validated or its LastLedgerSequence has passed.
      response = await this.client.submitAndWait(signed.tx_blob);
    }

    const result = response.result as unknown as {
      validated?: boolean;
      ledger_index?: number;
      meta?: { TransactionResult?: string } | string;
    };
    const txResult = typeof result.meta === "object" ? result.meta?.TransactionResult : undefined;
    if (!result.validated || txResult !== "tesSUCCESS") {
      throw new Error(`XRPL transaction ${signed.hash} not validated or failed (${txResult ?? "unknown"})`);
    }
    return { chain: "xrpl", txHash: signed.hash, position: result.ledger_index ?? 0 };
  }

  /**
   * Reads a record. With the reference of the transaction (from the local store) it reads
   * that transaction directly; without it, it searches the history of the API account,
   * which shows that records can be found without the local store.
   */
  async get(id: string, ref?: TxRef): Promise<{ payload: string; ref?: TxRef } | null> {
    const found = await this.findMemo(id, ref, (memo) => {
      const d = decodeRecordMemo(memo);
      return d && d.id === id ? d.payload : null;
    });
    return found ? { payload: found.data, ref: found.ref } : null;
  }

  /** Writes the anchor of a cross-chain record (FR5, SR11) and waits until it is validated (SR9). */
  async anchor(data: Omit<AnchorMemoData, "v" | "alg">): Promise<TxRef> {
    return this.submitMemo(encodeAnchorMemo(data));
  }

  /**
   * Finds the anchor of a record, written by the API account (SR12). Used to verify a record
   * and, before retrying a pending anchor, to avoid anchoring the same record twice.
   */
  async getAnchor(id: string, ref?: TxRef): Promise<{ data: AnchorMemoData; ref: TxRef } | null> {
    return this.findMemo(id, ref, (memo) => {
      const d = decodeAnchorMemo(memo);
      return d && d.id === id ? d : null;
    });
  }

  /** Finds a memo of the API account, by transaction hash or by searching the account history. */
  private async findMemo<T>(id: string, ref: TxRef | undefined, decode: (memo: XrplMemo) => T | null): Promise<{ data: T; ref: TxRef } | null> {
    await this.connect();
    if (ref?.txHash) {
      const res = await this.client.request({ command: "tx", transaction: ref.txHash });
      return this.extractMemo(res.result as never, decode);
    }
    let marker: unknown = undefined;
    const maxPages = this.opts.maxHistoryPages ?? 10;
    for (let page = 0; page < maxPages; page++) {
      const res: { result: unknown } = await this.client.request({
        command: "account_tx",
        account: this.wallet.classicAddress,
        limit: 200,
        ...(marker ? { marker } : {}),
      } as never);
      const r = res.result as { transactions: Array<Record<string, unknown>>; marker?: unknown };
      for (const entry of r.transactions) {
        const found = this.extractMemo(entry as never, decode);
        if (found) return found;
      }
      if (!r.marker) break;
      marker = r.marker;
    }
    return null;
  }

  /** Extracts a memo from a validated transaction, checking that it was sent by the API account (SR12). */
  private extractMemo<T>(entry: Record<string, unknown>, decode: (memo: XrplMemo) => T | null): { data: T; ref: TxRef } | null {
    // Depending on the API version, the transaction fields are at the top level, in "tx" or in "tx_json".
    const tx = (entry.tx_json ?? entry.tx ?? entry) as Record<string, unknown>;
    const hash = (entry.hash ?? tx.hash) as string | undefined;
    const validated = entry.validated as boolean | undefined;
    if (tx.Account !== this.wallet.classicAddress || validated === false) return null;
    const memos = (tx.Memos as XrplMemo[] | undefined) ?? [];
    for (const memo of memos) {
      const data = decode(memo);
      if (data !== null) {
        const position = Number(entry.ledger_index ?? tx.ledger_index ?? 0);
        return { data, ref: { chain: "xrpl", txHash: hash ?? "", position } };
      }
    }
    return null;
  }

  async status(): Promise<ChainStatus> {
    try {
      await this.connect();
      const info = await this.client.request({ command: "server_info" });
      const latest = info.result.info.validated_ledger?.seq;
      const acc = await this.client.request({
        command: "account_info",
        account: this.wallet.classicAddress,
        ledger_index: "validated",
      });
      return {
        chain: "xrpl",
        connected: true,
        latest,
        balance: String(dropsToXrp(acc.result.account_data.Balance)),
      };
    } catch (e) {
      return { chain: "xrpl", connected: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
