/**
 * Repeated measurements of time and cost (T3.5, NFR6).
 * Part A calls the adapters directly (time of each network); part B calls the running API
 * (time seen by a client). The difference of the medians is the time added by the API.
 *
 * The API must be running with the same configuration and a high rate limit, for example:
 *   RATE_LIMIT_PER_MINUTE=1000 DOTENV_CONFIG_PATH=.env.testnet npm run dev
 * Then:
 *   DOTENV_CONFIG_PATH=.env.testnet npm run measure -- 10 testnet
 * Results: ../evidencies/t35/<label>-<time>.csv and .json
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { XrplAdapter } from "../src/adapters/xrpl.js";
import { EvmAdapter } from "../src/adapters/evm.js";

const n = Number(process.argv[2] ?? 10);
const label = process.argv[3] ?? "run";
const base = process.env.API_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const key = (process.env.API_KEYS ?? "").split(",")[0]!.trim();
const rows: Array<{ part: string; op: string; i: number; ms: number; ok: boolean; info: string }> = [];

const xrpl = new XrplAdapter({
  wsUrl: process.env.XRPL_WS_URL!,
  seed: process.env.XRPL_SEED!,
  anchorDestination: process.env.XRPL_ANCHOR_DESTINATION!,
  maxPayloadBytes: 512,
  standalone: process.env.XRPL_STANDALONE === "true",
});
const evm = new EvmAdapter({
  rpcUrl: process.env.EVM_RPC_URL!,
  privateKey: process.env.EVM_PRIVATE_KEY!,
  chainId: Number(process.env.EVM_CHAIN_ID),
  contractAddress: process.env.EVM_CONTRACT_ADDRESS!,
  maxPayloadBytes: 4096,
  fromBlock: Number(process.env.EVM_FROM_BLOCK || 0),
});

const payload = (i: number, what: string) => JSON.stringify({ test: `measure ${what}`, i, at: new Date().toISOString() });

async function timed(part: string, op: string, i: number, fn: () => Promise<{ ok: boolean; info: string }>) {
  const t0 = performance.now();
  let r: { ok: boolean; info: string };
  try {
    r = await fn();
  } catch (e) {
    r = { ok: false, info: e instanceof Error ? e.message.slice(0, 120) : String(e) };
  }
  const ms = Math.round(performance.now() - t0);
  rows.push({ part, op, i, ms, ...r });
  console.log(`${part} ${op} #${i}: ${ms} ms ${r.ok ? "OK" : "FAIL"} ${r.info}`);
}

async function api(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-api-key": key, "content-type": "application/json" };
  if (method === "POST") {
    headers["x-timestamp"] = String(Math.floor(Date.now() / 1000));
    headers["x-nonce"] = randomBytes(16).toString("hex");
  }
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function balances() {
  const [x, e] = await Promise.all([xrpl.status(), evm.status()]);
  return { xrpl: Number(x.balance), evm: Number(e.balance) };
}

const stats = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  return { n: s.length, min: s[0], median: s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2, p90: q(0.9), max: s[s.length - 1], mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length) };
};

async function main() {
  const b0 = await balances();
  // Part A: adapters directly (time of each network, including signing and waiting for finality).
  for (let i = 1; i <= n; i++) await timed("direct", "xrpl.store", i, async () => ({ ok: !!(await xrpl.store(`m-x-${Date.now()}-${i}`, payload(i, "xrpl"))).txHash, info: "" }));
  const b1 = await balances();
  for (let i = 1; i <= n; i++) await timed("direct", "evm.store", i, async () => ({ ok: !!(await evm.store(`m-e-${Date.now()}-${i}`, payload(i, "evm"))).txHash, info: "" }));
  const b2 = await balances();
  await xrpl.disconnect();

  // Part B: through the API, as a client.
  for (let i = 1; i <= n; i++) {
    await timed("api", "POST /records xrpl", i, async () => {
      const r = await api("POST", "/records", { chain: "xrpl", payload: payload(i, "api xrpl") });
      return { ok: r.status === 201, info: String(r.status) };
    });
    await timed("api", "POST /records evm", i, async () => {
      const r = await api("POST", "/records", { chain: "evm", payload: payload(i, "api evm") });
      return { ok: r.status === 201, info: String(r.status) };
    });
    let id = "";
    await timed("api", "POST /records/cross-chain", i, async () => {
      const r = await api("POST", "/records/cross-chain", { payload: payload(i, "api cross-chain") });
      id = String(r.json.id ?? "");
      return { ok: r.status === 201 && r.json.state === "completed", info: `${r.status} ${r.json.state ?? ""}` };
    });
    await timed("api", "GET verify", i, async () => {
      const r = await api("GET", `/records/cross-chain/${id}/verify`);
      return { ok: r.status === 200 && r.json.valid === true, info: `valid=${r.json.valid}` };
    });
  }
  const b3 = await balances();

  const ops = [...new Set(rows.map((r) => `${r.part}|${r.op}`))];
  const summary: Record<string, unknown> = {};
  for (const o of ops) {
    const [part, op] = o.split("|");
    const rs = rows.filter((r) => r.part === part && r.op === op);
    summary[`${part} ${op}`] = { ...stats(rs.filter((r) => r.ok).map((r) => r.ms)), failures: rs.filter((r) => !r.ok).length };
  }
  const med = (k: string) => (summary[k] as { median: number }).median;
  const result = {
    label,
    at: new Date().toISOString(),
    executions: n,
    xrplUrl: process.env.XRPL_WS_URL,
    evmUrl: process.env.EVM_RPC_URL,
    timesMs: summary,
    apiOverheadMs: {
      xrpl: med("api POST /records xrpl") - med("direct xrpl.store"),
      evm: med("api POST /records evm") - med("direct evm.store"),
    },
    // Costs from the differences of balance (XRP), per operation.
    costXrp: {
      xrplStore: (b0.xrpl - b1.xrpl) / n,
      evmStore: (b1.evm - b2.evm) / n,
      apiPartXrplPerIteration: (b2.xrpl - b3.xrpl) / n,
      apiPartEvmPerIteration: (b2.evm - b3.evm) / n,
    },
  };
  const dir = join("..", "evidencies", "t35");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(dir, `${label}-${stamp}.csv`), "part,op,i,ms,ok,info\n" + rows.map((r) => `${r.part},${r.op},${r.i},${r.ms},${r.ok},"${r.info.replace(/"/g, "'")}"`).join("\n") + "\n");
  writeFileSync(join(dir, `${label}-${stamp}.json`), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
