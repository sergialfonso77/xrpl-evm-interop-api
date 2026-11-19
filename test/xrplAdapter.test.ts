import { describe, expect, it } from "vitest";
import { Wallet, type Client } from "xrpl";
import { PayloadTooLargeError, XrplAdapter } from "../src/adapters/xrpl.js";

const api = Wallet.generate();
const dest = Wallet.generate();

/** Minimal fake of the xrpl.js client: it keeps the submitted transactions in memory. */
function fakeClient(opts: { result?: string } = {}) {
  const txs = new Map<string, Record<string, unknown>>();
  let ledger = 10;
  const client = {
    isConnected: () => true,
    connect: async () => {},
    disconnect: async () => {},
    autofill: async (tx: Record<string, unknown>) => ({ ...tx, Fee: "12", Sequence: 1, LastLedgerSequence: ledger + 20 }),
    submit: async () => ({ result: { engine_result: "tesSUCCESS" } }),
    submitAndWait: async (blob: string) => ({ result: { validated: true, ledger_index: ledger, meta: { TransactionResult: opts.result ?? "tesSUCCESS" }, blob } }),
    request: async (req: Record<string, unknown>) => {
      switch (req.command) {
        case "ledger_accept":
          ledger++;
          return { result: {} };
        case "tx":
          return { result: txs.get(req.transaction as string) ?? { validated: false } };
        case "account_tx":
          return { result: { transactions: [...txs.values()].map((t) => ({ tx_json: t, hash: t.hash, validated: true, ledger_index: t.ledger_index })) } };
        case "server_info":
          return { result: { info: { validated_ledger: { seq: ledger } } } };
        case "account_info":
          return { result: { account_data: { Balance: "25000000" } } };
        default:
          throw new Error(`unexpected ${String(req.command)}`);
      }
    },
  };
  return { client: client as unknown as Client, txs };
}

const baseOpts = { wsUrl: "ws://localhost:6006", seed: api.seed!, anchorDestination: dest.classicAddress, maxPayloadBytes: 512 };

describe("XrplAdapter", () => {
  it("rejects payloads over the limit (SR2)", async () => {
    const { client } = fakeClient();
    const adapter = new XrplAdapter(baseOpts, client);
    await expect(adapter.store("id", "x".repeat(513))).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("returns the reference only when the transaction is validated with tesSUCCESS (SR9)", async () => {
    const { client } = fakeClient();
    const ref = await new XrplAdapter(baseOpts, client).store("id-1", "hello");
    expect(ref.chain).toBe("xrpl");
    expect(ref.txHash).toMatch(/^[0-9A-F]{64}$/);
  });

  it("fails if the transaction is not successful", async () => {
    const { client } = fakeClient({ result: "tecUNFUNDED_PAYMENT" });
    await expect(new XrplAdapter(baseOpts, client).store("id-1", "hello")).rejects.toThrow(/tecUNFUNDED_PAYMENT/);
  });

  it("finds a record in the account history without the local store", async () => {
    const { client, txs } = fakeClient();
    const adapter = new XrplAdapter(baseOpts, client);
    // Simulate a validated transaction of the API account with a record memo.
    const { encodeRecordMemo } = await import("../src/adapters/xrplMemo.js");
    txs.set("H1", { hash: "H1", Account: api.classicAddress, Memos: [encodeRecordMemo("id-9", "data")], ledger_index: 12 });
    const found = await adapter.get("id-9");
    expect(found?.payload).toBe("data");
    expect(found?.ref?.txHash).toBe("H1");
  });

  it("ignores records written by other accounts (SR12)", async () => {
    const { client, txs } = fakeClient();
    const adapter = new XrplAdapter(baseOpts, client);
    const { encodeRecordMemo } = await import("../src/adapters/xrplMemo.js");
    txs.set("H2", { hash: "H2", Account: dest.classicAddress, Memos: [encodeRecordMemo("id-9", "fake")], ledger_index: 12 });
    expect(await adapter.get("id-9")).toBeNull();
  });

  it("finds the anchor of a record written by the API account, and only that one (SR11, SR12)", async () => {
    const { client, txs } = fakeClient();
    const adapter = new XrplAdapter(baseOpts, client);
    const { encodeAnchorMemo, encodeRecordMemo } = await import("../src/adapters/xrplMemo.js");
    const data = { hash: "c".repeat(64), id: "id-7", evmChainId: 1449000, contract: "0x6fBc2efeb952602f8447640d27Ec145c8Bb83701", evmTx: "0x" + "d".repeat(64) };
    txs.set("F1", { hash: "F1", Account: dest.classicAddress, Memos: [encodeAnchorMemo({ ...data, hash: "e".repeat(64) })], ledger_index: 11 });
    txs.set("R1", { hash: "R1", Account: api.classicAddress, Memos: [encodeRecordMemo("id-7", "not an anchor")], ledger_index: 12 });
    txs.set("A1", { hash: "A1", Account: api.classicAddress, Memos: [encodeAnchorMemo(data)], ledger_index: 13 });
    const found = await adapter.getAnchor("id-7");
    expect(found?.data.hash).toBe(data.hash);
    expect(found?.ref.txHash).toBe("A1");
    expect(await adapter.getAnchor("other")).toBeNull();
  });

  it("reports the status and the balance of the API account", async () => {
    const { client } = fakeClient();
    const s = await new XrplAdapter(baseOpts, client).status();
    expect(s).toMatchObject({ chain: "xrpl", connected: true, balance: "25" });
  });
});

describe("walletFromSeed", () => {
  it("uses secp256k1 for classic seeds (genesis account of a stand-alone ledger)", async () => {
    const { walletFromSeed } = await import("../src/adapters/xrpl.js");
    expect(walletFromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb").classicAddress).toBe("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh");
  });
  it("keeps Ed25519 seeds", async () => {
    const { walletFromSeed } = await import("../src/adapters/xrpl.js");
    expect(walletFromSeed(api.seed!).classicAddress).toBe(api.classicAddress);
  });
});
