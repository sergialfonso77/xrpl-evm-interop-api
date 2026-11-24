import { Contract, Interface, JsonRpcProvider, Wallet, formatEther, getAddress, keccak256, toUtf8Bytes } from "ethers";
import type { ChainAdapter, ChainStatus } from "./chain.js";
import type { TxRef } from "../domain/record.js";
import { payloadSize, sha256Hex } from "../domain/hash.js";
import { PayloadTooLargeError } from "./xrpl.js";

/** Interface of the RecordStore contract used by the API (contracts/src/RecordStore.sol). */
export const RECORD_STORE_ABI = [
  "function store(bytes32 id, string payload)",
  "function get(bytes32 id) view returns (string payload, uint64 timestamp, bool exists)",
  "function writer() view returns (address)",
  "event RecordStored(bytes32 indexed id, bytes32 contentHash)",
];
const iface = new Interface(RECORD_STORE_ABI);
const RECORD_STORED_TOPIC = iface.getEvent("RecordStored")!.topicHash;

/**
 * Key of a record in the contract. The API uses text identifiers (UUID) and the contract
 * uses bytes32 keys, so the key is the Keccak-256 hash of the identifier. Anyone can
 * compute it in the same way to find a record without the API.
 */
export function recordKey(id: string): string {
  return keccak256(toUtf8Bytes(id));
}

/** Minimal parts of a transaction receipt used by the adapter. */
export interface ReceiptLike {
  hash: string;
  status: number | null;
  blockNumber: number;
  logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }>;
}

/** Minimal parts of the provider (JSON-RPC node) used by the adapter, so that it can be replaced in tests. */
export interface ProviderLike {
  getNetwork(): Promise<{ chainId: bigint }>;
  getBlockNumber(): Promise<number>;
  getCode(address: string): Promise<string>;
  getBalance(address: string): Promise<bigint>;
  getTransactionReceipt(hash: string): Promise<ReceiptLike | null>;
  getLogs(filter: { address: string; topics: Array<string | null>; fromBlock: number; toBlock: number | "latest" }): Promise<
    ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string; transactionHash: string; blockNumber: number }>
  >;
}

/** Minimal parts of the contract used by the adapter. */
export interface RecordStoreLike {
  store(id: string, payload: string): Promise<{ hash: string; wait(confirmations?: number): Promise<ReceiptLike | null> }>;
  get(id: string): Promise<[string, bigint, boolean]>;
}

export interface EvmAdapterOptions {
  rpcUrl: string;
  privateKey: string;
  chainId: number;
  contractAddress: string;
  maxPayloadBytes: number;
  /**
   * Blocks to wait after the block that includes the transaction. The XRPL EVM has
   * deterministic finality (CometBFT), so one block is enough; Anvil confirms immediately.
   */
  confirmations?: number;
  /** First block searched when a record is looked up without the reference of its transaction (deployment block). */
  fromBlock?: number;
  /**
   * Attempts to read a record that should exist because its transaction is known. Public RPC
   * endpoints are served by several nodes, and a node that is a few blocks behind can still
   * answer that the record does not exist just after it was stored.
   */
  readAttempts?: number;
  /** Wait between those attempts, in milliseconds. */
  readRetryMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The record read from the contract does not match the hash in the event of its transaction. */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

/**
 * Adapter of the EVM chain (FR2). Records are stored in the RecordStore contract of the API,
 * which emits an event with the SHA-256 hash of each payload.
 */
export class EvmAdapter implements ChainAdapter {
  readonly name = "evm" as const;
  private readonly provider: ProviderLike;
  private readonly contract: RecordStoreLike;
  private readonly contractAddress: string;
  private readonly address: string;
  private networkChecked = false;
  /** Writes are sent one after another, so that two transactions never get the same nonce. */
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly opts: EvmAdapterOptions,
    deps?: { provider: ProviderLike; contract: RecordStoreLike; address: string },
  ) {
    this.contractAddress = getAddress(opts.contractAddress);
    if (deps) {
      this.provider = deps.provider;
      this.contract = deps.contract;
      this.address = getAddress(deps.address);
    } else {
      // ethers.js shares identical requests made within 250 ms. For the nonce of the account
      // this returns a stale value when two writes are close in time ("nonce too low"), so the
      // cache is disabled.
      const provider = new JsonRpcProvider(opts.rpcUrl, undefined, { cacheTimeout: -1 });
      const wallet = new Wallet(opts.privateKey, provider);
      this.provider = provider as unknown as ProviderLike;
      this.contract = new Contract(this.contractAddress, RECORD_STORE_ABI, wallet) as unknown as RecordStoreLike;
      this.address = wallet.address;
    }
  }

  /** Public address of the API account (to be published, SR12). */
  get accountAddress(): string {
    return this.address;
  }

  /** Checks once that the node belongs to the configured chain, so that nothing is sent to a wrong network. */
  private async checkNetwork(): Promise<void> {
    if (this.networkChecked) return;
    const { chainId } = await this.provider.getNetwork();
    if (Number(chainId) !== this.opts.chainId) {
      throw new Error(`The node is on chain ${chainId}, but the configuration expects chain ${this.opts.chainId}`);
    }
    // A transaction to an address without code succeeds without doing anything, so the
    // address of the contract is checked too (for example, after a local chain is restarted).
    const code = await this.provider.getCode(this.contractAddress);
    if (!code || code === "0x") {
      throw new Error(`There is no contract at ${this.contractAddress} on chain ${chainId}: deploy RecordStore and update EVM_CONTRACT_ADDRESS`);
    }
    this.networkChecked = true;
  }

  async store(id: string, payload: string): Promise<TxRef> {
    const run = this.writeQueue.then(() => this.storeNow(id, payload));
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async storeNow(id: string, payload: string): Promise<TxRef> {
    const size = payloadSize(payload);
    if (size > this.opts.maxPayloadBytes) throw new PayloadTooLargeError(size, this.opts.maxPayloadBytes);
    await this.checkNetwork();

    const tx = await this.contract.store(recordKey(id), payload);
    // wait() returns when the transaction is included in a block, and throws if it reverted.
    const receipt = await tx.wait(this.opts.confirmations ?? 1);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`EVM transaction ${tx.hash} failed or was not included in a block`);
    }
    // The record is only reported as stored if the event of the API contract carries the expected hash (SR8).
    this.checkEvent(receipt.logs, id, payload, tx.hash);
    return this.ref(tx.hash, receipt.blockNumber);
  }

  /**
   * Reads a record from the contract. With the reference of its transaction, it also checks
   * that the event of that transaction comes from the API contract and carries the hash of
   * the payload. Without it, it looks for the event in the logs of the contract.
   */
  async get(id: string, ref?: TxRef): Promise<{ payload: string; ref?: TxRef } | null> {
    await this.checkNetwork();
    // With a reference the record is known to exist, so a negative answer is retried (see readAttempts).
    const attempts = ref ? (this.opts.readAttempts ?? 10) : 1;
    let payload = "";
    let exists = false;
    for (let i = 0; i < attempts && !exists; i++) {
      if (i > 0) await sleep(this.opts.readRetryMs ?? 1000);
      [payload, , exists] = await this.contract.get(recordKey(id));
    }
    if (!exists) {
      if (ref) throw new IntegrityError(`Record ${id} not found in the contract, although transaction ${ref.txHash} is referenced`);
      return null;
    }

    if (ref) {
      if (ref.chainId !== undefined && ref.chainId !== this.opts.chainId) {
        throw new IntegrityError(`Reference points to chain ${ref.chainId}, not to chain ${this.opts.chainId}`);
      }
      if (ref.contractAddress && getAddress(ref.contractAddress) !== this.contractAddress) {
        throw new IntegrityError(`Reference points to contract ${ref.contractAddress}, not to the API contract (SR8)`);
      }
      const receipt = await this.provider.getTransactionReceipt(ref.txHash);
      if (!receipt || receipt.status !== 1) throw new IntegrityError(`Transaction ${ref.txHash} not found or failed`);
      this.checkEvent(receipt.logs, id, payload, ref.txHash);
      return { payload, ref: this.ref(ref.txHash, receipt.blockNumber) };
    }

    // The record exists in the contract, so its event exists too. A node that is behind can
    // still return no logs just after the record was stored, so the search is retried.
    let log: Awaited<ReturnType<ProviderLike["getLogs"]>>[number] | undefined;
    for (let i = 0; i < (this.opts.readAttempts ?? 10) && !log; i++) {
      if (i > 0) await sleep(this.opts.readRetryMs ?? 1000);
      const logs = await this.provider.getLogs({
        address: this.contractAddress,
        topics: [RECORD_STORED_TOPIC, recordKey(id)],
        fromBlock: this.opts.fromBlock ?? 0,
        toBlock: "latest",
      });
      log = logs.find((l) => getAddress(l.address) === this.contractAddress);
    }
    // Without the event the payload is still returned, but without a reference that can be verified.
    if (!log) return { payload };
    this.checkEvent([log], id, payload, log.transactionHash);
    return { payload, ref: this.ref(log.transactionHash, log.blockNumber) };
  }

  /** Finds the RecordStored event of the API contract for this record and compares its hash with the payload. */
  private checkEvent(logs: ReceiptLike["logs"], id: string, payload: string, txHash: string): void {
    const key = recordKey(id).toLowerCase();
    for (const log of logs) {
      // Events emitted by any other contract are ignored, even if they look identical (SR8).
      if (getAddress(log.address) !== this.contractAddress) continue;
      if (log.topics[0] !== RECORD_STORED_TOPIC || log.topics[1]?.toLowerCase() !== key) continue;
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      const contentHash = String(parsed!.args.contentHash).toLowerCase();
      if (contentHash !== "0x" + sha256Hex(payload)) {
        throw new IntegrityError(`The hash in the event of ${txHash} does not match the payload`);
      }
      return;
    }
    throw new IntegrityError(`No RecordStored event of the API contract for this record in ${txHash} (SR8)`);
  }

  private ref(txHash: string, blockNumber: number): TxRef {
    return { chain: "evm", txHash, position: blockNumber, chainId: this.opts.chainId, contractAddress: this.contractAddress };
  }

  async status(): Promise<ChainStatus> {
    try {
      await this.checkNetwork();
      const [latest, balance] = await Promise.all([this.provider.getBlockNumber(), this.provider.getBalance(this.address)]);
      return { chain: "evm", connected: true, latest, balance: formatEther(balance) };
    } catch (e) {
      return { chain: "evm", connected: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
