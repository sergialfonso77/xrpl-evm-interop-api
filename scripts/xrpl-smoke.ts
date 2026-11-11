/**
 * Manual integration test of the XRP Ledger adapter against a real node
 * (local stand-alone node or Testnet). Run with: npm run xrpl:smoke
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { XrplAdapter } from "../src/adapters/xrpl.js";

async function main() {
  const adapter = new XrplAdapter({
    wsUrl: process.env.XRPL_WS_URL!,
    seed: process.env.XRPL_SEED!,
    anchorDestination: process.env.XRPL_ANCHOR_DESTINATION!,
    maxPayloadBytes: Number(process.env.MAX_XRPL_PAYLOAD_BYTES ?? 512),
    standalone: process.env.XRPL_STANDALONE === "true",
  });

  console.log("Status:", await adapter.status());

  const id = randomUUID();
  const payload = JSON.stringify({ test: "hello XRPL", at: new Date().toISOString() });
  const t0 = Date.now();
  const ref = await adapter.store(id, payload);
  console.log(`Stored ${id} in ${Date.now() - t0} ms:`, ref);

  const byRef = await adapter.get(id, ref);
  console.log("Read with reference:", byRef?.payload === payload ? "OK" : "MISMATCH", byRef?.payload);

  const byHistory = await adapter.get(id);
  console.log("Read from account history (without local store):", byHistory?.payload === payload ? "OK" : "MISMATCH");

  await adapter.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
