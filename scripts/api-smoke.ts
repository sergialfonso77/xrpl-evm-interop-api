/**
 * End-to-end test of the running API (T3.4): it calls every route like a client would.
 * Start the API first (npm run dev, or DOTENV_CONFIG_PATH=.env.testnet npm run dev),
 * then in another terminal: npm run api:smoke (with the same DOTENV_CONFIG_PATH).
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";

const base = process.env.API_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const key = (process.env.API_KEYS ?? "").split(",")[0]!.trim();

async function call(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-api-key": key, "content-type": "application/json" };
  if (method === "POST") {
    headers["x-timestamp"] = String(Math.floor(Date.now() / 1000));
    headers["x-nonce"] = randomBytes(16).toString("hex");
  }
  const t0 = Date.now();
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = (await res.json()) as Record<string, unknown>;
  console.log(`${method} ${path} -> ${res.status} (${Date.now() - t0} ms)`);
  return { status: res.status, json };
}

async function main() {
  const status = await call("GET", "/status");
  console.log(JSON.stringify(status.json, null, 2));

  for (const chain of ["xrpl", "evm"] as const) {
    const payload = JSON.stringify({ test: `api ${chain}`, at: new Date().toISOString() });
    const created = await call("POST", "/records", { chain, payload });
    const read = await call("GET", `/records/${chain}/${created.json.id}`);
    console.log(`  ${chain}: read = sent? ${read.json.payload === payload ? "OK" : "MISMATCH"}`);
  }

  const payload = JSON.stringify({ test: "api cross-chain", at: new Date().toISOString() });
  const cross = await call("POST", "/records/cross-chain", { payload });
  console.log(JSON.stringify(cross.json, null, 2));
  const id = cross.json.id as string;
  const read = await call("GET", `/records/cross-chain/${id}`);
  console.log(`  cross-chain: state ${read.json.state}, read = sent? ${read.json.payload === payload ? "OK" : "MISMATCH"}`);
  const verify = await call("GET", `/records/cross-chain/${id}/verify`);
  console.log(JSON.stringify(verify.json, null, 2));

  // Negative checks of the security requirements.
  const noKey = await fetch(base + `/records/evm/${id}`);
  console.log(`  without API key -> ${noKey.status} (expected 401)`);
  const headers = { "x-api-key": key, "content-type": "application/json", "x-timestamp": String(Math.floor(Date.now() / 1000)), "x-nonce": randomBytes(16).toString("hex") };
  const body = JSON.stringify({ chain: "xrpl", payload: "x".repeat(513) });
  const tooLarge = await fetch(base + "/records", { method: "POST", headers, body });
  console.log(`  payload of 513 bytes on xrpl -> ${tooLarge.status} (expected 413)`);
  const replay = await fetch(base + "/records", { method: "POST", headers, body });
  console.log(`  same nonce again -> ${replay.status} (expected 409)`);

  const anchor = (cross.json.refs as Array<{ chain: string; txHash: string }> | undefined)?.find((r) => r.chain === "xrpl");
  if (anchor) console.log(`\nAnchor transaction for the independent verification: ${anchor.txHash}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
