/**
 * Saves the activity of the API accounts on the XRP Ledger as JSON files, so that it remains
 * available as evidence after a reset of the test network (the XRPL Testnet and Devnet were
 * reset on 25 November 2026). Run with:
 *   DOTENV_CONFIG_PATH=.env.testnet npm run save-evidence
 * The files are written to ../evidencies/xrpl-testnet-<date>/.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, convertHexToString } from "xrpl";
import { walletFromSeed } from "../src/adapters/xrpl.js";

async function main() {
  const api = walletFromSeed(process.env.XRPL_SEED!).classicAddress;
  const dest = process.env.XRPL_ANCHOR_DESTINATION!;
  const day = new Date().toISOString().slice(0, 10);
  const dir = join("..", "evidencies", `xrpl-testnet-${day}`);
  mkdirSync(dir, { recursive: true });

  const client = new Client(process.env.XRPL_WS_URL!);
  await client.connect();
  const save = (name: string, data: unknown) => writeFileSync(join(dir, name), JSON.stringify(data, null, 2) + "\n");

  const info = await client.request({ command: "server_info" });
  save("server_info.json", { url: process.env.XRPL_WS_URL, saved_at: new Date().toISOString(), result: info.result });

  for (const [name, account] of [["api", api], ["destination", dest]] as const) {
    const acc = await client.request({ command: "account_info", account, ledger_index: "validated" });
    save(`account_info_${name}.json`, acc.result);
  }

  // Full history of the API account, oldest first, page by page.
  const txs: Array<Record<string, unknown>> = [];
  let marker: unknown = undefined;
  do {
    const res = await client.request({ command: "account_tx", account: api, forward: true, limit: 200, ...(marker ? { marker } : {}) } as never);
    const r = (res as { result: { transactions: Array<Record<string, unknown>>; marker?: unknown } }).result;
    txs.push(...r.transactions);
    marker = r.marker;
  } while (marker);
  save("account_tx_api.json", txs);
  await client.disconnect();

  // Readable summary: one line per transaction, with its decoded memo type.
  const lines = ["| Date (UTC) | Ledger | Hash | Type | Result | Memo type |", "|---|---|---|---|---|---|"];
  for (const t of txs) {
    const tx = (t.tx_json ?? t.tx ?? t) as Record<string, unknown>;
    const meta = t.meta as { TransactionResult?: string } | undefined;
    const memos = (tx.Memos as Array<{ Memo: { MemoType?: string } }> | undefined) ?? [];
    const memoType = memos.map((m) => (m.Memo.MemoType ? convertHexToString(m.Memo.MemoType) : "")).join(", ");
    lines.push(`| ${t.close_time_iso ?? ""} | ${t.ledger_index ?? ""} | ${t.hash ?? tx.hash} | ${tx.TransactionType} | ${meta?.TransactionResult ?? ""} | ${memoType} |`);
  }
  writeFileSync(join(dir, "summary.md"), `# XRPL Testnet activity of the API account ${api}\n\nSaved ${new Date().toISOString()} from ${process.env.XRPL_WS_URL}\n\n${lines.join("\n")}\n`);
  console.log(`Saved ${txs.length} transactions of ${api} in ${dir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
