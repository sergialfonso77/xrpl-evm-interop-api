import "dotenv/config";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { openDb } from "./store/db.js";
import { XrplAdapter } from "./adapters/xrpl.js";

const config = loadConfig();
openDb(config.DB_PATH);

const xrpl = new XrplAdapter({
  wsUrl: config.XRPL_WS_URL,
  seed: config.XRPL_SEED,
  anchorDestination: config.XRPL_ANCHOR_DESTINATION,
  maxPayloadBytes: config.MAX_XRPL_PAYLOAD_BYTES,
  standalone: config.XRPL_STANDALONE,
});

// The EVM adapter is added in T3.3.
const app = createApp({ adapters: [xrpl] });

app.listen(config.PORT, () => {
  console.log(`API listening on port ${config.PORT}`);
});
