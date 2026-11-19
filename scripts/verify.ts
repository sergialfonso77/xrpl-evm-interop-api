/**
 * Independent verification of a cross-chain record (SR5, Section 3.2.5).
 * It does NOT use the API, its local store or its code: only public nodes of both chains
 * and the published addresses of the API (SR12). Anyone can run it.
 *
 * Usage:
 *   XRPL_WS_URL=wss://s.altnet.rippletest.net:51233 EVM_RPC_URL=https://rpc.testnet.xrplevm.org/ \
 *   API_XRPL_ACCOUNT=r... API_EVM_CONTRACT=0x... npm run verify -- <hash of the anchor transaction>
 */
import { createHash } from "node:crypto";
import { Client, convertHexToString } from "xrpl";
import { Contract, JsonRpcProvider, getAddress, id as keccakText } from "ethers";

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
};

async function main() {
  const anchorTx = process.argv[2];
  if (!anchorTx) throw new Error("Usage: npm run verify -- <hash of the anchor transaction on the XRP Ledger>");
  const apiAccount = env("API_XRPL_ACCOUNT");
  const apiContract = getAddress(env("API_EVM_CONTRACT"));
  const checks: Array<[string, boolean]> = [];
  const check = (name: string, ok: boolean) => {
    checks.push([name, ok]);
    console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
    return ok;
  };

  // 1. Read the anchor transaction on the XRP Ledger.
  const xrpl = new Client(env("XRPL_WS_URL"));
  await xrpl.connect();
  const res = await xrpl.request({ command: "tx", transaction: anchorTx });
  await xrpl.disconnect();
  const r = res.result as unknown as Record<string, unknown>;
  const tx = (r.tx_json ?? r) as Record<string, unknown>;
  const meta = r.meta as { TransactionResult?: string } | undefined;
  check("anchor transaction is in a validated ledger with tesSUCCESS", r.validated === true && meta?.TransactionResult === "tesSUCCESS");

  // 2. It must have been sent by the published account of the API; otherwise anyone could write a false anchor.
  if (!check(`anchor sent by the API account ${apiAccount}`, tx.Account === apiAccount)) return finish(checks);

  // Decode the memo of the anchor (SR11).
  const memos = (tx.Memos as Array<{ Memo: { MemoType?: string; MemoData?: string } }>) ?? [];
  const memo = memos.find((m) => m.Memo.MemoType && convertHexToString(m.Memo.MemoType) === "tfm-api/anchor/v1");
  if (!check("transaction contains an anchor memo (tfm-api/anchor/v1)", !!memo?.Memo.MemoData)) return finish(checks);
  const a = JSON.parse(convertHexToString(memo!.Memo.MemoData!)) as {
    alg: string; hash: string; id: string; evmChainId: number; contract: string; evmTx: string;
  };
  console.log("Anchor:", a);
  check("hash algorithm is sha256", a.alg === "sha256");

  // 3. Read the record from the contract given in the anchor, which must be the published contract (SR8).
  const evm = new JsonRpcProvider(env("EVM_RPC_URL"));
  const { chainId } = await evm.getNetwork();
  check(`EVM node is on chain ${a.evmChainId}`, Number(chainId) === a.evmChainId);
  if (!check("contract of the anchor is the published contract of the API", getAddress(a.contract) === apiContract)) return finish(checks);
  const key = keccakText(a.id); // key of the record in the contract: keccak256 of its identifier
  const store = new Contract(apiContract, ["function get(bytes32) view returns (string, uint64, bool)"], evm);
  const [payload, , exists] = (await store.get(key)) as [string, bigint, boolean];
  if (!check("record exists in the contract", exists)) return finish(checks);

  // 4. Recompute the SHA-256 hash of the payload and compare it with the anchored hash.
  const hash = createHash("sha256").update(Buffer.from(payload, "utf8")).digest("hex");
  console.log("Payload:", payload);
  console.log("SHA-256 of the payload:", hash);
  check("SHA-256 of the payload = anchored hash", hash === a.hash);

  // Extra: the event of the EVM transaction of the anchor carries the same hash.
  const receipt = await evm.getTransactionReceipt(a.evmTx);
  const topic = keccakText("RecordStored(bytes32,bytes32)");
  const log = receipt?.logs.find((l) => getAddress(l.address) === apiContract && l.topics[0] === topic && l.topics[1] === key);
  check("event RecordStored of the EVM transaction carries the same hash", !!log && log.data.toLowerCase() === "0x" + a.hash);

  finish(checks);
}

function finish(checks: Array<[string, boolean]>) {
  const ok = checks.every(([, v]) => v);
  console.log(ok ? "\nRESULT: VALID. The record has not been modified since it was anchored." : "\nRESULT: NOT VALID.");
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
