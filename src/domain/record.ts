/** Chains supported by the API. */
export type ChainName = "xrpl" | "evm";

/** Reference to a transaction on one chain. */
export interface TxRef {
  chain: ChainName;
  txHash: string;
  /** Ledger index (XRP Ledger) or block number (EVM). */
  position: number;
  /** Only for the EVM chain. */
  chainId?: number;
  contractAddress?: string;
}

/** Record as returned by the API (Section 3.2.2, data model). */
export interface StoredRecord {
  id: string;
  chain: ChainName | "cross-chain";
  payload: string;
  contentHash: string;
  refs: TxRef[];
}

/** States of a cross-chain operation (Section 3.2.4). */
export type OperationState =
  | "received"
  | "stored_on_evm"
  | "final_on_evm"
  | "anchored"
  | "completed"
  | "pending_anchor"
  /** The record could not be stored on the EVM chain, so nothing was written on-chain. */
  | "failed";
