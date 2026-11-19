import { describe, expect, it } from "vitest";
import { convertStringToHex } from "xrpl";
import { XRPL_MEMOS_MAX_BYTES, decodeAnchorMemo, decodeRecordMemo, encodeAnchorMemo, encodeRecordMemo, memoSizeBytes } from "../src/adapters/xrplMemo.js";

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

describe("anchor memo (SR11)", () => {
  const data = {
    hash: "a".repeat(64),
    id: "123e4567-e89b-12d3-a456-426614174000",
    evmChainId: 1449000,
    contract: "0x6fBc2efeb952602f8447640d27Ec145c8Bb83701",
    evmTx: "0x" + "b".repeat(64),
  };
  it("round-trips an anchor with all the fields needed to verify it", () => {
    expect(decodeAnchorMemo(encodeAnchorMemo(data))).toEqual({ v: 1, alg: "sha256", ...data });
  });
  it("is not confused with a record memo", () => {
    expect(decodeRecordMemo(encodeAnchorMemo(data))).toBeNull();
    expect(decodeAnchorMemo(encodeRecordMemo("id", "{}"))).toBeNull();
  });
  it("fits in the Memos field", () => {
    expect(memoSizeBytes(encodeAnchorMemo(data))).toBeLessThanOrEqual(XRPL_MEMOS_MAX_BYTES);
  });
});
