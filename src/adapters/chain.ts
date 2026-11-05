import type { ChainName, TxRef } from "../domain/record.js";

/** Status of the connection with one chain (FR7). */
export interface ChainStatus {
  chain: ChainName;
  connected: boolean;
  /** Last validated ledger (XRPL) or latest block (EVM), if connected. */
  latest?: number;
  /** Balance of the API account, in the native unit (XRP), used for the low-balance warning (SR13). */
  balance?: string;
  error?: string;
}

/**
 * Common interface implemented by every chain adapter (Adapter pattern, NFR2).
 * Adding a new chain only requires a new class that implements this interface.
 */
export interface ChainAdapter {
  readonly name: ChainName;
  /** Stores a record and returns the reference of the final transaction (SR9). */
  store(id: string, payload: string): Promise<TxRef>;
  /** Reads a record by its identifier, or returns null if it does not exist. */
  get(id: string): Promise<{ payload: string; ref?: TxRef } | null>;
  status(): Promise<ChainStatus>;
}
