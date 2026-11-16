import "dotenv/config";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { openDb } from "./store/db.js";
import { XrplAdapter } from "./adapters/xrpl.js";
import { EvmAdapter } from "./adapters/evm.js";
import type { ChainAdapter } from "./adapters/chain.js";

const config = loadConfig();
openDb(config.DB_PATH);

const xrpl = new XrplAdapter({
  wsUrl: config.XRPL_WS_URL,
  seed: config.XRPL_SEED,
  anchorDestination: config.XRPL_ANCHOR_DESTINATION,
  maxPayloadBytes: config.MAX_XRPL_PAYLOAD_BYTES,
  standalone: config.XRPL_STANDALONE,
});

const adapters: ChainAdapter[] = [xrpl];
if (config.EVM_CONTRACT_ADDRESS) {
  adapters.push(
    new EvmAdapter({
      rpcUrl: config.EVM_RPC_URL,
      privateKey: config.EVM_PRIVATE_KEY,
      chainId: config.EVM_CHAIN_ID,
      contractAddress: config.EVM_CONTRACT_ADDRESS,
      maxPayloadBytes: config.MAX_EVM_PAYLOAD_BYTES,
      fromBlock: config.EVM_FROM_BLOCK,
    }),
  );
} else {
  console.warn("EVM_CONTRACT_ADDRESS is empty: the EVM chain is disabled until the contract is deployed.");
}
const app = createApp({ adapters });

app.listen(config.PORT, () => {
  console.log(`API listening on port ${config.PORT}`);
});
