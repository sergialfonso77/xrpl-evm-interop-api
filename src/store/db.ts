import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Local store (SQLite). It keeps the index of records, the state of the cross-chain
 * operations and the nonces used against replay (SR4). It is not part of the trust model:
 * if it is lost, records and anchors can still be found and verified on-chain.
 */
export function openDb(path: string): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      id            TEXT PRIMARY KEY,
      chain         TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      state         TEXT NOT NULL,
      refs_json     TEXT NOT NULL DEFAULT '[]',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS nonces (
      api_key_hash  TEXT NOT NULL,
      nonce         TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (api_key_hash, nonce)
    );
  `);
  // Column added in T3.4: last error of an operation (for example, why an anchor is pending).
  const columns = db.prepare("PRAGMA table_info(records)").all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "last_error")) db.exec("ALTER TABLE records ADD COLUMN last_error TEXT");
  return db;
}
