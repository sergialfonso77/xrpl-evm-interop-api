import { describe, expect, it } from "vitest";
import { Interface, Wallet, keccak256, toUtf8Bytes } from "ethers";
import { EvmAdapter, IntegrityError, RECORD_STORE_ABI, recordKey, type ProviderLike, type ReceiptLike, type RecordStoreLike } from "../src/adapters/evm.js";
import { PayloadTooLargeError } from "../src/adapters/xrpl.js";
import { sha256Hex } from "../src/domain/hash.js";

const iface = new Interface(RECORD_STORE_ABI);
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const OTHER_CONTRACT = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const account = Wallet.createRandom();

function eventLog(address: string, id: string, payload: string) {
  const { topics, data } = iface.encodeEventLog(iface.getEvent("RecordStored")!, [recordKey(id), "0x" + sha256Hex(payload)]);
  return { address, topics, data };
}

/** Fake chain: a contract that keeps records in memory and a provider that returns its receipts and logs. */
function fakeChain(opts: { chainId?: bigint; status?: number; eventFrom?: string; tamper?: boolean } = {}) {
  const records = new Map<string, string>();
  const receipts = new Map<string, ReceiptLike>();
  let block = 100;
  const contract: RecordStoreLike = {
    async store(key, payload) {
      if (records.has(key)) throw new Error("RecordAlreadyExists");
      const hash = keccak256(toUtf8Bytes(`tx-${receipts.size}`));
      return {
        hash,
        wait: async () => {
          block++;
          const id = [...pending.entries()].find(([, k]) => k === key)?.[0] ?? "";
          const receipt: ReceiptLike = {
            hash,
            status: opts.status ?? 1,
            blockNumber: block,
            logs: [eventLog(opts.eventFrom ?? CONTRACT, id, opts.tamper ? payload + "x" : payload)],
          };
          if (receipt.status === 1) records.set(key, payload);
          receipts.set(hash, receipt);
          return receipt;
        },
      };
    },
    async get(key) {
      const p = records.get(key);
      return [p ?? "", p ? 1n : 0n, p !== undefined];
    },
  };
  const pending = new Map<string, string>();
  const provider: ProviderLike = {
    getNetwork: async () => ({ chainId: opts.chainId ?? 31337n }),
    getBlockNumber: async () => block,
    getBalance: async () => 5n * 10n ** 18n,
    getTransactionReceipt: async (h) => receipts.get(h) ?? null,
    getLogs: async (f) =>
      [...receipts.values()].flatMap((r) =>
        r.logs
          .filter((l) => l.address.toLowerCase() === f.address.toLowerCase() && l.topics[1] === f.topics[1])
          .map((l) => ({ ...l, transactionHash: r.hash, blockNumber: r.blockNumber })),
      ),
  };
  /** Registers the identifier of a key, so that the fake contract can build the event like the real one. */
  const track = (id: string) => pending.set(id, recordKey(id));
  return { contract, provider, track, records };
}

const baseOpts = { rpcUrl: "http://localhost:8545", privateKey: account.privateKey, chainId: 31337, contractAddress: CONTRACT, maxPayloadBytes: 4096 };

function adapterWith(chain: ReturnType<typeof fakeChain>, opts: Partial<typeof baseOpts> = {}) {
  return new EvmAdapter({ ...baseOpts, ...opts }, { provider: chain.provider, contract: chain.contract, address: account.address });
}

describe("EvmAdapter", () => {
  it("uses the Keccak-256 hash of the identifier as the key of the record", () => {
    expect(recordKey("abc")).toBe(keccak256(toUtf8Bytes("abc")));
  });

  it("rejects payloads over the limit (SR2)", async () => {
    const chain = fakeChain();
    await expect(adapterWith(chain).store("a", "x".repeat(4097))).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("refuses to work with a node of another chain", async () => {
    const chain = fakeChain({ chainId: 1n });
    chain.track("a");
    await expect(adapterWith(chain).store("a", "{}")).rejects.toThrow(/chain 1/);
  });

  it("stores a record and returns the reference of the transaction (SR9)", async () => {
    const chain = fakeChain();
    chain.track("rec-1");
    const ref = await adapterWith(chain).store("rec-1", '{"a":1}');
    expect(ref).toMatchObject({ chain: "evm", position: 101, chainId: 31337, contractAddress: CONTRACT });
  });

  it("fails if the transaction reverted", async () => {
    const chain = fakeChain({ status: 0 });
    chain.track("rec-1");
    await expect(adapterWith(chain).store("rec-1", "{}")).rejects.toThrow(/failed/);
  });

  it("does not accept an event emitted by another contract (SR8)", async () => {
    const chain = fakeChain({ eventFrom: OTHER_CONTRACT });
    chain.track("rec-1");
    await expect(adapterWith(chain).store("rec-1", "{}")).rejects.toBeInstanceOf(IntegrityError);
  });

  it("detects an event whose hash does not match the payload", async () => {
    const chain = fakeChain({ tamper: true });
    chain.track("rec-1");
    await expect(adapterWith(chain).store("rec-1", "{}")).rejects.toBeInstanceOf(IntegrityError);
  });

  it("reads a record with its reference and without it", async () => {
    const chain = fakeChain();
    chain.track("rec-1");
    const adapter = adapterWith(chain);
    const ref = await adapter.store("rec-1", '{"a":1}');
    expect((await adapter.get("rec-1", ref))?.payload).toBe('{"a":1}');
    const found = await adapter.get("rec-1");
    expect(found?.payload).toBe('{"a":1}');
    expect(found?.ref?.txHash).toBe(ref.txHash);
    expect(await adapter.get("unknown")).toBeNull();
  });

  it("retries a read with reference when the node is still behind", async () => {
    const chain = fakeChain();
    chain.track("rec-1");
    const adapter = adapterWith(chain, { readRetryMs: 1 } as never);
    const ref = await adapter.store("rec-1", '{"a":1}');
    const realGet = chain.contract.get;
    let calls = 0;
    chain.contract.get = async (key) => (++calls < 3 ? ["", 0n, false] : realGet(key));
    expect((await adapter.get("rec-1", ref))?.payload).toBe('{"a":1}');
    expect(calls).toBe(3);
  });

  it("retries the search of the event when the logs of the node are behind", async () => {
    const chain = fakeChain();
    chain.track("rec-1");
    const adapter = adapterWith(chain, { readRetryMs: 1 } as never);
    const ref = await adapter.store("rec-1", "{}");
    const realGetLogs = chain.provider.getLogs;
    let calls = 0;
    chain.provider.getLogs = async (f) => (++calls < 3 ? [] : realGetLogs(f));
    expect((await adapter.get("rec-1"))?.ref?.txHash).toBe(ref.txHash);
    expect(calls).toBe(3);
  });

  it("reports an error if a referenced record never appears", async () => {
    const chain = fakeChain();
    chain.track("rec-1");
    const adapter = adapterWith(chain, { readRetryMs: 1, readAttempts: 2 } as never);
    const ref = await adapter.store("rec-1", "{}");
    chain.contract.get = async () => ["", 0n, false];
    await expect(adapter.get("rec-1", ref)).rejects.toBeInstanceOf(IntegrityError);
  });

  it("rejects a reference that points to another contract (SR8)", async () => {
    const chain = fakeChain();
    chain.track("rec-1");
    const adapter = adapterWith(chain);
    const ref = await adapter.store("rec-1", "{}");
    await expect(adapter.get("rec-1", { ...ref, contractAddress: OTHER_CONTRACT })).rejects.toBeInstanceOf(IntegrityError);
  });

  it("sends the writes one after another, even if two requests arrive at the same time", async () => {
    const chain = fakeChain();
    chain.track("a");
    chain.track("b");
    let active = 0;
    let maxActive = 0;
    const realStore = chain.contract.store;
    chain.contract.store = async (key, payload) => {
      active++;
      maxActive = Math.max(maxActive, active);
      const tx = await realStore(key, payload);
      return { hash: tx.hash, wait: async (c?: number) => { const r = await tx.wait(c); active--; return r; } };
    };
    const adapter = adapterWith(chain);
    await Promise.all([adapter.store("a", "{}"), adapter.store("b", "{}")]);
    expect(maxActive).toBe(1);
  });

  it("reports the status and the balance of the API account", async () => {
    const status = await adapterWith(fakeChain()).status();
    expect(status).toEqual({ chain: "evm", connected: true, latest: 100, balance: "5.0" });
  });
});
