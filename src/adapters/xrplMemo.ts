import { convertHexToString, convertStringToHex } from "xrpl";

/**
 * Encoding of the data written in the Memos field of XRP Ledger transactions.
 * Memo fields are hex-encoded, and the whole Memos field cannot exceed 1 KB in binary format.
 */
export const MEMO_TYPE_RECORD = "tfm-api/record/v1";
export const MEMO_TYPE_ANCHOR = "tfm-api/anchor/v1";
export const MEMO_FORMAT_JSON = "application/json";
/** Limit of the Memos field of the XRP Ledger, in bytes. */
export const XRPL_MEMOS_MAX_BYTES = 1024;

export interface XrplMemo {
  Memo: { MemoType?: string; MemoFormat?: string; MemoData?: string };
}

export interface RecordMemoData {
  v: 1;
  id: string;
  payload: string;
}

/** Builds the memo that stores a record directly on the XRP Ledger (FR1). */
export function encodeRecordMemo(id: string, payload: string): XrplMemo {
  const data: RecordMemoData = { v: 1, id, payload };
  return {
    Memo: {
      MemoType: convertStringToHex(MEMO_TYPE_RECORD),
      MemoFormat: convertStringToHex(MEMO_FORMAT_JSON),
      MemoData: convertStringToHex(JSON.stringify(data)),
    },
  };
}

/** Size of a memo in bytes once decoded from hex (approximation of its binary size). */
export function memoSizeBytes(memo: XrplMemo): number {
  const m = memo.Memo;
  return [m.MemoType, m.MemoFormat, m.MemoData].reduce((sum, h) => sum + (h ? h.length / 2 : 0), 0);
}

/** Decodes a record memo, or returns null if the memo is not a valid record memo of this API. */
export function decodeRecordMemo(memo: XrplMemo): RecordMemoData | null {
  const m = memo.Memo;
  if (!m.MemoType || !m.MemoData) return null;
  if (convertHexToString(m.MemoType) !== MEMO_TYPE_RECORD) return null;
  try {
    const data = JSON.parse(convertHexToString(m.MemoData)) as Partial<RecordMemoData>;
    if (data.v !== 1 || typeof data.id !== "string" || typeof data.payload !== "string") return null;
    return { v: 1, id: data.id, payload: data.payload };
  } catch {
    return null;
  }
}

/**
 * Data of an anchor (FR5, SR11): everything needed to find and verify the record on the
 * EVM chain without the API. The hash is the SHA-256 of the payload, in hexadecimal.
 */
export interface AnchorMemoData {
  v: 1;
  alg: "sha256";
  hash: string;
  id: string;
  evmChainId: number;
  contract: string;
  evmTx: string;
}

/** Builds the memo of an anchor (FR5). */
export function encodeAnchorMemo(data: Omit<AnchorMemoData, "v" | "alg">): XrplMemo {
  const full: AnchorMemoData = { v: 1, alg: "sha256", ...data };
  return {
    Memo: {
      MemoType: convertStringToHex(MEMO_TYPE_ANCHOR),
      MemoFormat: convertStringToHex(MEMO_FORMAT_JSON),
      MemoData: convertStringToHex(JSON.stringify(full)),
    },
  };
}

/** Decodes an anchor memo, or returns null if the memo is not a valid anchor of this API. */
export function decodeAnchorMemo(memo: XrplMemo): AnchorMemoData | null {
  const m = memo.Memo;
  if (!m.MemoType || !m.MemoData) return null;
  if (convertHexToString(m.MemoType) !== MEMO_TYPE_ANCHOR) return null;
  try {
    const d = JSON.parse(convertHexToString(m.MemoData)) as Partial<AnchorMemoData>;
    if (
      d.v !== 1 || d.alg !== "sha256" || typeof d.hash !== "string" || !/^[0-9a-f]{64}$/.test(d.hash) ||
      typeof d.id !== "string" || typeof d.evmChainId !== "number" || typeof d.contract !== "string" ||
      typeof d.evmTx !== "string"
    ) {
      return null;
    }
    return { v: 1, alg: "sha256", hash: d.hash, id: d.id, evmChainId: d.evmChainId, contract: d.contract, evmTx: d.evmTx };
  } catch {
    return null;
  }
}
