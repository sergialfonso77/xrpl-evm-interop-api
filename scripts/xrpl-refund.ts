/**
 * Funds again the existing XRP Ledger accounts of the API after a reset of the test network
 * (the XRPL Testnet was reset on 25 November 2026). The addresses do not change.
 *   DOTENV_CONFIG_PATH=.env.testnet npm run xrpl:refund
 * The API account is funded by the faucet; then it sends 10 XRP to the destination account,
 * which creates it again (a payment of 1 drop cannot create an account).
 */
import "dotenv/config";
import { Client, xrpToDrops, type Payment } from "xrpl";
import { walletFromSeed } from "../src/adapters/xrpl.js";

async function main() {
  if (process.env.XRPL_STANDALONE === "true") throw new Error("Use npm run xrpl:setup for the local node");
  const client = new Client(process.env.XRPL_WS_URL!);
  await client.connect();
  const api = walletFromSeed(process.env.XRPL_SEED!);
  const dest = process.env.XRPL_ANCHOR_DESTINATION!;

  const { balance } = await client.fundWallet(api);
  console.log(`API account ${api.classicAddress} funded by the faucet: ${balance} XRP`);

  const tx: Payment = { TransactionType: "Payment", Account: api.classicAddress, Destination: dest, Amount: xrpToDrops(10) };
  const res = await client.submitAndWait(tx, { wallet: api, autofill: true });
  const meta = res.result.meta as { TransactionResult?: string };
  console.log(`Destination account ${dest} created with 10 XRP: ${meta.TransactionResult} (tx ${res.result.hash})`);
  await client.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
