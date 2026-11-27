import { randomUUID } from "node:crypto";
import type { ChainAdapter, ChainStatus } from "./adapters/chain.js";
import type { AnchorMemoData } from "./adapters/xrplMemo.js";
import { IntegrityError } from "./adapters/evm.js";
import { PayloadTooLargeError } from "./adapters/xrpl.js";
import { sha256Hex } from "./domain/hash.js";
import type { ChainName, OperationState, TxRef } from "./domain/record.js";
import type { RecordRepository } from "./store/records.js";

/** XRP Ledger adapter with the operations needed for anchors (implemented by XrplAdapter). */
export interface AnchorChain extends ChainAdapter {
  anchor(data: Omit<AnchorMemoData, "v" | "alg">): Promise<TxRef>;
  getAnchor(id: string, ref?: TxRef): Promise<{ data: AnchorMemoData; ref: TxRef } | null>;
}

export class NotFoundError extends Error {
  readonly name = "NotFoundError";
}

/** A chain could not complete an operation (it is not available or the transaction failed). */
export class ChainError extends Error {
  readonly name = "ChainError";
  constructor(readonly chain: ChainName, cause: unknown) {
    super(`${chain}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export interface RecordResult {
  id: string;
  chain: ChainName;
  payload?: string;
  contentHash: string;
  ref?: TxRef;
}

export interface CrossChainResult {
  id: string;
  chain: "cross-chain";
  payload?: string;
  contentHash: string;
  state: OperationState;
  refs: TxRef[];
  lastError?: string;
}

export interface VerifyResult {
  id: string;
  valid: boolean;
  reason?: string;
  storedHash?: string;
  anchoredHash: string;
  anchor: TxRef;
  evm: TxRef;
}

export interface ServiceOptions {
  /** Balances below these values produce a warning in the status (SR13), in XRP. */
  lowBalance: { xrpl: number; evm: number };
  /** Minutes without changes after which an operation in an intermediate state is resumed (default 10). */
  interruptedAfterMinutes?: number;
}

/**
 * Logic of the API, independent of HTTP (Section 3.2.1, core service). The chains are only
 * used through their adapters, so a new chain only needs a new adapter (NFR2).
 */
export class RecordService {
  private retrying = false;

  constructor(
    private readonly xrpl: AnchorChain,
    private readonly evm: ChainAdapter,
    private readonly repo: RecordRepository,
    private readonly opts: ServiceOptions,
  ) {}

  private adapter(chain: ChainName): ChainAdapter {
    return chain === "xrpl" ? this.xrpl : this.evm;
  }

  /** Stores a record on one chain (FR1, FR2, FR4). */
  async store(chain: ChainName, payload: string): Promise<RecordResult> {
    const id = randomUUID();
    const contentHash = sha256Hex(payload);
    const ref = await this.call(chain, () => this.adapter(chain).store(id, payload));
    this.repo.insert({ id, chain, contentHash, state: "completed", refs: [ref] });
    return { id, chain, contentHash, ref };
  }

  /** Reads a record from one chain (FR3). The local index is only used to find the transaction faster. */
  async get(chain: ChainName, id: string): Promise<RecordResult> {
    const row = this.repo.get(id);
    if (row && row.chain !== chain) throw new NotFoundError(`Record ${id} is not a record of chain ${chain}`);
    const ref = row?.refs.find((r) => r.chain === chain);
    const found = await this.call(chain, () => this.adapter(chain).get(id, ref));
    if (!found) throw new NotFoundError(`Record ${id} not found on ${chain}`);
    return { id, chain, payload: found.payload, contentHash: sha256Hex(found.payload), ref: found.ref ?? ref };
  }

  /**
   * Cross-chain operation (FR5, Section 3.2.4): stores the record on the EVM chain, waits until
   * it is final, and anchors its hash on the XRP Ledger. If the anchor cannot be written, the
   * operation stays in the state pending_anchor and is retried later.
   */
  async crossChain(payload: string): Promise<CrossChainResult> {
    const id = randomUUID();
    const contentHash = sha256Hex(payload);
    this.repo.insert({ id, chain: "cross-chain", contentHash, state: "received" });

    let evmRef: TxRef;
    try {
      // The adapter returns only when the transaction is final and its event has been checked (SR8, SR9).
      evmRef = await this.call("evm", () => this.evm.store(id, payload));
    } catch (e) {
      this.repo.update(id, { state: "failed", lastError: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    this.repo.update(id, { state: "stored_on_evm", addRef: evmRef });
    this.repo.update(id, { state: "final_on_evm" });

    await this.writeAnchor(id, contentHash, evmRef);
    return this.crossChainResult(id);
  }

  private async writeAnchor(id: string, contentHash: string, evmRef: TxRef): Promise<void> {
    try {
      const anchorRef = await this.xrpl.anchor({
        hash: contentHash,
        id,
        evmChainId: evmRef.chainId!,
        contract: evmRef.contractAddress!,
        evmTx: evmRef.txHash,
      });
      this.repo.update(id, { state: "anchored", addRef: anchorRef, lastError: null });
      this.repo.update(id, { state: "completed" });
    } catch (e) {
      this.repo.update(id, { state: "pending_anchor", lastError: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Retries the pending anchors. Before writing an anchor, it checks on the XRP Ledger whether
   * one already exists for that record (for example, if the first attempt was validated after
   * a timeout), so that a record is never anchored twice.
   */
  async retryPendingAnchors(): Promise<number> {
    if (this.retrying) return 0;
    this.retrying = true;
    let done = 0;
    try {
      await this.resumeInterrupted();
      for (const row of this.repo.pendingAnchors()) {
        const evmRef = row.refs.find((r) => r.chain === "evm");
        if (!evmRef) continue;
        try {
          const existing = await this.xrpl.getAnchor(row.id);
          if (existing) {
            this.repo.update(row.id, { state: "anchored", addRef: existing.ref, lastError: null });
            this.repo.update(row.id, { state: "completed" });
            done++;
            continue;
          }
        } catch (e) {
          this.repo.update(row.id, { state: "pending_anchor", lastError: e instanceof Error ? e.message : String(e) });
          continue;
        }
        await this.writeAnchor(row.id, row.contentHash, evmRef);
        if (this.repo.get(row.id)?.state === "completed") done++;
      }
    } finally {
      this.retrying = false;
    }
    return done;
  }

  /**
   * Resumes the operations that stopped in an intermediate state (for example, if the API was
   * stopped in the middle of one). If the record is on the EVM chain, its anchor becomes pending
   * and is written by the normal retry; if it is not, nothing was written and the operation fails.
   */
  private async resumeInterrupted(): Promise<void> {
    for (const row of this.repo.interrupted(this.opts.interruptedAfterMinutes ?? 10)) {
      try {
        if (row.state === "anchored") {
          this.repo.update(row.id, { state: "completed" });
          continue;
        }
        let evmRef = row.refs.find((r) => r.chain === "evm");
        if (!evmRef) {
          const found = await this.evm.get(row.id);
          if (!found) {
            this.repo.update(row.id, { state: "failed", lastError: "Interrupted before the record was stored on the EVM chain" });
            continue;
          }
          if (!found.ref || sha256Hex(found.payload) !== row.contentHash) {
            this.repo.update(row.id, { state: "failed", lastError: "Interrupted; the record on the EVM chain could not be checked" });
            continue;
          }
          evmRef = found.ref;
          this.repo.update(row.id, { state: "final_on_evm", addRef: evmRef });
        }
        this.repo.update(row.id, { state: "pending_anchor", lastError: "Interrupted before the anchor was written" });
      } catch (e) {
        // The chain is not available: the operation is resumed in the next round.
        this.repo.update(row.id, { state: row.state, lastError: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  /** Reads a cross-chain record, with its state and the references on both chains. */
  async getCrossChain(id: string): Promise<CrossChainResult> {
    const row = this.repo.get(id);
    if (!row || row.chain !== "cross-chain") throw new NotFoundError(`Cross-chain record ${id} not found`);
    const result = this.crossChainResult(id);
    const evmRef = row.refs.find((r) => r.chain === "evm");
    if (evmRef) {
      const found = await this.call("evm", () => this.evm.get(id, evmRef));
      if (found) result.payload = found.payload;
    }
    return result;
  }

  private crossChainResult(id: string): CrossChainResult {
    const row = this.repo.get(id)!;
    return { id, chain: "cross-chain", contentHash: row.contentHash, state: row.state, refs: row.refs, ...(row.lastError ? { lastError: row.lastError } : {}) };
  }

  /**
   * Verifies a cross-chain record (FR6) following the same steps as the independent
   * verification (Section 3.2.5): it reads the anchor written by the API account, reads the
   * record from the contract and the chain given in the anchor, and compares the hashes.
   */
  async verify(id: string): Promise<VerifyResult> {
    const row = this.repo.get(id);
    const anchorRef = row?.refs.find((r) => r.chain === "xrpl");
    const anchor = await this.call("xrpl", () => this.xrpl.getAnchor(id, anchorRef));
    if (!anchor) {
      throw new NotFoundError(row?.state === "pending_anchor" ? `The anchor of ${id} is still pending` : `No anchor found for ${id}`);
    }
    const evmRef: TxRef = {
      chain: "evm",
      txHash: anchor.data.evmTx,
      position: 0,
      chainId: anchor.data.evmChainId,
      contractAddress: anchor.data.contract,
    };
    const base = { id, anchoredHash: anchor.data.hash, anchor: anchor.ref, evm: evmRef };
    try {
      const found = await this.evm.get(id, evmRef);
      if (!found) return { ...base, valid: false, reason: "The record does not exist in the contract given by the anchor" };
      const storedHash = sha256Hex(found.payload);
      const valid = storedHash === anchor.data.hash;
      return { ...base, evm: found.ref ?? evmRef, storedHash, valid, ...(valid ? {} : { reason: "The hash of the record does not match the anchored hash" }) };
    } catch (e) {
      if (e instanceof IntegrityError) return { ...base, valid: false, reason: e.message };
      throw new ChainError("evm", e);
    }
  }

  /** Status of the API and of each chain, with a warning when a balance is low (FR7, SR13). */
  async status(): Promise<{ chains: ChainStatus[]; warnings: string[] }> {
    const chains = await Promise.all(
      [this.xrpl, this.evm].map((a) => a.status().catch((e: unknown) => ({ chain: a.name, connected: false, error: String(e) }) as ChainStatus)),
    );
    const warnings: string[] = [];
    for (const c of chains) {
      const min = this.opts.lowBalance[c.chain];
      if (c.connected && c.balance !== undefined && Number(c.balance) < min) {
        warnings.push(`Low balance on ${c.chain}: ${c.balance} XRP (warning threshold ${min} XRP)`);
      }
    }
    const pending = this.repo.pendingAnchors().length;
    if (pending > 0) warnings.push(`${pending} cross-chain record(s) waiting for their anchor`);
    return { chains, warnings };
  }

  /** Runs an operation on a chain and turns its failures into ChainError, except the errors of the request. */
  private async call<T>(chain: ChainName, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PayloadTooLargeError || e instanceof IntegrityError || e instanceof NotFoundError) throw e;
      throw new ChainError(chain, e);
    }
  }
}
