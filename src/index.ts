import "dotenv/config";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { openDb } from "./store/db.js";

const config = loadConfig();
openDb(config.DB_PATH);

// The chain adapters are added in T3.2 (XRPL) and T3.3 (EVM).
const app = createApp({ adapters: [] });

app.listen(config.PORT, () => {
  console.log(`API listening on port ${config.PORT}`);
});
