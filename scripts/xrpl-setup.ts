/**
 * Creates and funds the two XRP Ledger accounts of the API (main account and second account
 * that receives the payments carrying memos). Run with: npm run xrpl:setup
 * - Stand-alone mode: funds them from the genesis account of the local node.
 * - Testnet: uses the public faucet.
 * Copy the printed values into .env. Test networks only, without real funds (LR2).
 */
import "dotenv/config";
import { Client, Wallet, xrpToDrops } from "xrpl";
import { walletFromSeed } from "../src/adapters/xrpl.js";

// Genesis account of a new stand-alone ledger (public test value from the XRP Ledger documentation).
const GENESIS_SEED = "snoPBrXtMeMyMHUVTgbuqAfg1SUTb";

const url = process.env.XRPL_WS_URL ?? "ws://127.0.0.1:6006";
const standalone = process.env.XRPL_STANDALONE === "true";

async function main() {
  const client = new Client(url);
  await client.connect();
  const api = Wallet.generate();
  const dest = Wallet.generate();

  if (standalone) {
    const genesis = walletFromSeed(GENESIS_SEED);
    for (const w of [api, dest]) {
      const tx = await client.autofill({
        TransactionType: "Payment",
        Account: genesis.classicAddress,
        Destination: w.classicAddress,
        Amount: xrpToDrops(1000),
      });
      const signed = genesis.sign(tx);
      await client.submit(signed.tx_blob);
      await client.request({ command: "ledger_accept" } as never);
    }
  } else {
    await client.fundWallet(api);
    await client.fundWallet(dest);
  }
  await client.disconnect();

  console.log("Add these values to .env:\n");
  console.log(`XRPL_SEED=${api.seed}`);
  console.log(`XRPL_ANCHOR_DESTINATION=${dest.classicAddress}`);
  console.log(`\nAPI account (publish it, SR12): ${api.classicAddress}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
