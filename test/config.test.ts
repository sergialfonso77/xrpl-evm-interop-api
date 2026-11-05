import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const valid = {
  API_KEYS: "key1, key2",
  XRPL_WS_URL: "ws://localhost:6006",
  XRPL_SEED: "sEdTestSeedOnly",
  XRPL_ANCHOR_DESTINATION: "rDestination",
  EVM_RPC_URL: "http://localhost:8545",
  EVM_PRIVATE_KEY: "0x" + "11".repeat(32),
  EVM_CHAIN_ID: "31337",
};

describe("loadConfig", () => {
  it("parses a valid configuration and applies defaults", () => {
    const c = loadConfig(valid as NodeJS.ProcessEnv);
    expect(c.API_KEYS).toEqual(["key1", "key2"]);
    expect(c.MAX_XRPL_PAYLOAD_BYTES).toBe(512);
    expect(c.MAX_EVM_PAYLOAD_BYTES).toBe(4096);
  });
  it("rejects a malformed private key", () => {
    expect(() => loadConfig({ ...valid, EVM_PRIVATE_KEY: "abc" } as NodeJS.ProcessEnv)).toThrow(/EVM_PRIVATE_KEY/);
  });
});
