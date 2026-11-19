import { randomBytes, randomUUID } from "node:crypto";
import { IntegrityError } from "../src/adapters/evm.js";
import { PayloadTooLargeError } from "../src/adapters/xrpl.js";
import type { AnchorMemoData } from "../src/adapters/xrplMemo.js";
import type { TxRef } from "../src/domain/record.js";
import type { AnchorChain } from "../src/service.js";
import type { ChainAdapter } from "../src/adapters/chain.js";

export const CONTRACT = "0x6fBc2efeb952602f8447640d27Ec145c8Bb83701";
const txHash = () => "0x" + randomBytes(32).toString("hex");

/** Simulated EVM chain: records in memory, optional failures and a way to tamper with a record. */
export function fakeEvm(opts: { down?: boolean; max?: number; balance?: string } = {}) {
  const records = new Map<string, string>();
  let block = 100;
  const adapter: ChainAdapter & { tamper(id: string, payload: string): void; stores: number } = {
    name: "evm",
    stores: 0,
    async store(id: string, payload: string): Promise<TxRef> {
      if (opts.down) throw new Error("connect ECONNREFUSED");
      if (Buffer.byteLength(payload) > (opts.max ?? 4096)) throw new PayloadTooLargeError(Buffer.byteLength(payload), opts.max ?? 4096);
      records.set(id, payload);
      adapter.stores++;
      return { chain: "evm", txHash: txHash(), position: ++block, chainId: 1449000, contractAddress: CONTRACT };
    },
    async get(id: string, ref?: TxRef) {
      if (ref?.contractAddress && ref.contractAddress !== CONTRACT) throw new IntegrityError("Reference points to another contract (SR8)");
      const payload = records.get(id);
      return payload === undefined ? null : { payload, ref };
    },
    async status() {
      return { chain: "evm" as const, connected: !opts.down, latest: block, balance: opts.balance ?? "197.6" };
    },
    tamper(id: string, payload: string) {
      records.set(id, payload);
    },
  };
  return adapter;
}

/** Simulated XRP Ledger: records and anchors in memory; anchors can fail a number of times. */
export function fakeXrpl(opts: { failAnchors?: number; anchorButReportFailure?: boolean; balance?: string } = {}) {
  const records = new Map<string, string>();
  const anchors = new Map<string, { data: AnchorMemoData; ref: TxRef }>();
  let ledger = 1000;
  let failures = opts.failAnchors ?? 0;
  const adapter: AnchorChain & { anchorsWritten: number; anchors: typeof anchors } = {
    name: "xrpl",
    anchorsWritten: 0,
    anchors,
    async store(id: string, payload: string): Promise<TxRef> {
      if (Buffer.byteLength(payload) > 512) throw new PayloadTooLargeError(Buffer.byteLength(payload), 512);
      records.set(id, payload);
      return { chain: "xrpl", txHash: randomUUID(), position: ++ledger };
    },
    async get(id: string, ref?: TxRef) {
      const payload = records.get(id);
      return payload === undefined ? null : { payload, ref };
    },
    async anchor(data) {
      if (failures > 0) {
        failures--;
        if (opts.anchorButReportFailure) {
          // The anchor is validated, but the API does not receive the answer (for example, a timeout).
          anchors.set(data.id, { data: { v: 1, alg: "sha256", ...data }, ref: { chain: "xrpl", txHash: randomUUID(), position: ++ledger } });
          adapter.anchorsWritten++;
        }
        throw new Error("XRPL not available");
      }
      const ref: TxRef = { chain: "xrpl", txHash: randomUUID(), position: ++ledger };
      anchors.set(data.id, { data: { v: 1, alg: "sha256", ...data }, ref });
      adapter.anchorsWritten++;
      return ref;
    },
    async getAnchor(id: string) {
      return anchors.get(id) ?? null;
    },
    async status() {
      return { chain: "xrpl" as const, connected: true, latest: ledger, balance: opts.balance ?? "99.9" };
    },
  };
  return adapter;
}
