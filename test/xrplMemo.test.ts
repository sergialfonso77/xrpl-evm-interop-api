import { describe, expect, it } from "vitest";
import { convertStringToHex } from "xrpl";
import { XRPL_MEMOS_MAX_BYTES, decodeRecordMemo, encodeRecordMemo, memoSizeBytes } from "../src/adapters/xrplMemo.js";

describe("record memo", () => {
  it("round-trips a record", () => {
    const memo = encodeRecordMemo("id-1", '{"a":1}');
    expect(decodeRecordMemo(memo)).toEqual({ v: 1, id: "id-1", payload: '{"a":1}' });
  });
  it("ignores memos of other formats", () => {
    expect(decodeRecordMemo({ Memo: { MemoType: convertStringToHex("other"), MemoData: "00" } })).toBeNull();
  });
  it("keeps a 512-byte payload within the 1 KB limit of the Memos field", () => {
    const memo = encodeRecordMemo("123e4567-e89b-12d3-a456-426614174000", "x".repeat(512));
    expect(memoSizeBytes(memo)).toBeLessThanOrEqual(XRPL_MEMOS_MAX_BYTES);
  });
});
