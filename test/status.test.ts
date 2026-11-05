import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { ChainAdapter } from "../src/adapters/chain.js";

const fake = (name: "xrpl" | "evm", connected: boolean): ChainAdapter => ({
  name,
  store: async () => { throw new Error("not used"); },
  get: async () => null,
  status: async () => ({ chain: name, connected }),
});

describe("GET /status", () => {
  it("reports every chain", async () => {
    const app = createApp({ adapters: [fake("xrpl", true), fake("evm", false)] });
    const res = await request(app).get("/status");
    expect(res.status).toBe(200);
    expect(res.body.chains).toHaveLength(2);
    expect(res.body.allChainsConnected).toBe(false);
  });
});
