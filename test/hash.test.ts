import { describe, expect, it } from "vitest";
import { payloadSize, sha256Hex } from "../src/domain/hash.js";

describe("sha256Hex", () => {
  it("matches a known test vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("hashes the payload exactly as received (no JSON reformatting)", () => {
    expect(sha256Hex('{"a":1}')).not.toBe(sha256Hex('{ "a": 1 }'));
  });
});

describe("payloadSize", () => {
  it("counts UTF-8 bytes, not characters", () => {
    expect(payloadSize("à")).toBe(2);
  });
});
