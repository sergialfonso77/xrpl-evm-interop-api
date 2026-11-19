import type Database from "better-sqlite3";
import type { ChainName, OperationState, TxRef } from "../domain/record.js";

/** Row of the local index of records. The payload itself is only kept on-chain. */
export interface RecordRow {
  id: string;
  chain: ChainName | "cross-chain";
  contentHash: string;
  state: OperationState;
  refs: TxRef[];
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Local index of records and states of the cross-chain operations (Section 3.2.4).
 * It only speeds up reads and keeps the states: every record can also be found on-chain.
 */
export class RecordRepository {
  constructor(private readonly db: Database.Database) {}

  insert(row: { id: string; chain: RecordRow["chain"]; contentHash: string; state: OperationState; refs?: TxRef[] }): void {
    this.db
      .prepare("INSERT INTO records (id, chain, content_hash, state, refs_json) VALUES (?, ?, ?, ?, ?)")
      .run(row.id, row.chain, row.contentHash, row.state, JSON.stringify(row.refs ?? []));
  }

  /** Changes the state of a record and, optionally, adds a reference or records the last error. */
  update(id: string, change: { state: OperationState; addRef?: TxRef; lastError?: string | null }): void {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown record ${id}`);
    const refs = change.addRef ? [...current.refs.filter((r) => r.chain !== change.addRef!.chain), change.addRef] : current.refs;
    this.db
      .prepare("UPDATE records SET state = ?, refs_json = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?")
      .run(change.state, JSON.stringify(refs), change.lastError === undefined ? (current.lastError ?? null) : change.lastError, id);
  }

  get(id: string): RecordRow | null {
    const r = this.db.prepare("SELECT * FROM records WHERE id = ?").get(id) as Record<string, string> | undefined;
    if (!r) return null;
    return {
      id: r.id,
      chain: r.chain as RecordRow["chain"],
      contentHash: r.content_hash,
      state: r.state as OperationState,
      refs: JSON.parse(r.refs_json) as TxRef[],
      lastError: r.last_error ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /** Cross-chain records whose anchor is still pending, oldest first. */
  pendingAnchors(): RecordRow[] {
    const rows = this.db.prepare("SELECT id FROM records WHERE state = 'pending_anchor' ORDER BY created_at").all() as Array<{ id: string }>;
    return rows.map((r) => this.get(r.id)!);
  }
}
