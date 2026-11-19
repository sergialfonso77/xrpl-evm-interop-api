import "dotenv/config";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { openDb } from "./store/db.js";
import { RecordRepository } from "./store/records.js";
import { RecordService } from "./service.js";
import { XrplAdapter } from "./adapters/xrpl.js";
import { EvmAdapter } from "./adapters/evm.js";

const config = loadConfig();
if (!config.EVM_CONTRACT_ADDRESS) {
  console.error("EVM_CONTRACT_ADDRESS is empty: deploy the RecordStore contract first (see README).");
  process.exit(1);
}
const db = openDb(config.DB_PATH);

const xrpl = new XrplAdapter({
  wsUrl: config.XRPL_WS_URL,
  seed: config.XRPL_SEED,
  anchorDestination: config.XRPL_ANCHOR_DESTINATION,
  maxPayloadBytes: config.MAX_XRPL_PAYLOAD_BYTES,
  standalone: config.XRPL_STANDALONE,
});
const evm = new EvmAdapter({
  rpcUrl: config.EVM_RPC_URL,
  privateKey: config.EVM_PRIVATE_KEY,
  chainId: config.EVM_CHAIN_ID,
  contractAddress: config.EVM_CONTRACT_ADDRESS,
  maxPayloadBytes: config.MAX_EVM_PAYLOAD_BYTES,
  fromBlock: config.EVM_FROM_BLOCK,
});

const service = new RecordService(xrpl, evm, new RecordRepository(db), {
  lowBalance: { xrpl: config.XRPL_LOW_BALANCE, evm: config.EVM_LOW_BALANCE },
});
const app = createApp({
  service,
  db,
  security: { apiKeys: config.API_KEYS, maxAgeSeconds: config.REQUEST_MAX_AGE_SECONDS, ratePerMinute: config.RATE_LIMIT_PER_MINUTE },
});

// Pending anchors are retried periodically (Section 3.2.4).
setInterval(() => {
  service.retryPendingAnchors().catch((e: unknown) => console.error("Retry of pending anchors failed:", e));
}, config.ANCHOR_RETRY_SECONDS * 1000).unref();

app.listen(config.PORT, () => {
  // The public addresses are printed so that they can be published (SR12).
  console.log(`API listening on port ${config.PORT}`);
  console.log(`XRP Ledger account of the API: ${xrpl.address}`);
  console.log(`EVM account of the API: ${evm.accountAddress}; RecordStore contract: ${config.EVM_CONTRACT_ADDRESS} (chain ${config.EVM_CHAIN_ID})`);
});
