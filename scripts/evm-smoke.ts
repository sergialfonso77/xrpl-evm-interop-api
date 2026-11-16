/**
 * Manual integration test of the EVM adapter against a real node
 * (local Anvil or XRPL EVM Testnet). Run with: npm run evm:smoke
 * For the Testnet: DOTENV_CONFIG_PATH=.env.testnet npm run evm:smoke
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { EvmAdapter, recordKey } from "../src/adapters/evm.js";
import { sha256Hex } from "../src/domain/hash.js";

async function main() {
  if (!process.env.EVM_CONTRACT_ADDRESS) throw new Error("EVM_CONTRACT_ADDRESS is empty: deploy the contract first (see README)");
  const adapter = new EvmAdapter({
    rpcUrl: process.env.EVM_RPC_URL!,
    privateKey: process.env.EVM_PRIVATE_KEY!,
    chainId: Number(process.env.EVM_CHAIN_ID),
    contractAddress: process.env.EVM_CONTRACT_ADDRESS,
    maxPayloadBytes: Number(process.env.MAX_EVM_PAYLOAD_BYTES ?? 4096),
    fromBlock: Number(process.env.EVM_FROM_BLOCK || 0),
  });

  console.log("Account:", adapter.accountAddress);
  console.log("Status:", await adapter.status());

  const id = randomUUID();
  const payload = JSON.stringify({ test: "hello XRPL EVM", at: new Date().toISOString() });
  console.log(`Record ${id}: key ${recordKey(id)}, SHA-256 ${sha256Hex(payload)}`);
  const t0 = Date.now();
  const ref = await adapter.store(id, payload);
  console.log(`Stored in ${Date.now() - t0} ms:`, ref);

  const byRef = await adapter.get(id, ref);
  console.log("Read with reference (event of the API contract, hash checked):", byRef?.payload === payload ? "OK" : "MISMATCH", byRef?.payload);

  const byLogs = await adapter.get(id);
  console.log(
    "Read without reference (contract state + event in the logs):",
    byLogs?.payload === payload && byLogs?.ref?.txHash === ref.txHash ? "OK" : "MISMATCH",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
