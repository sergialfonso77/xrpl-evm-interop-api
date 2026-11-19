import request from "supertest";
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createApp } from "../src/app.js";
import { openDb } from "../src/store/db.js";
import { RecordRepository } from "../src/store/records.js";
import { RecordService } from "../src/service.js";
import { sha256Hex } from "../src/domain/hash.js";
import { fakeEvm, fakeXrpl } from "./helpers.js";

const KEY = "test-key-0123456789";

function setup(opts: { xrpl?: ReturnType<typeof fakeXrpl>; evm?: ReturnType<typeof fakeEvm>; rate?: number; now?: () => number } = {}) {
  const db = openDb(":memory:");
  const xrpl = opts.xrpl ?? fakeXrpl();
  const evm = opts.evm ?? fakeEvm();
  const service = new RecordService(xrpl, evm, new RecordRepository(db), { lowBalance: { xrpl: 20, evm: 1 } });
  const app = createApp({ service, db, security: { apiKeys: [KEY], maxAgeSeconds: 300, ratePerMinute: opts.rate ?? 30, now: opts.now } });
  return { app, service, xrpl, evm };
}

/** Headers of a write request (SR1, SR4). */
const write = (over: Record<string, string> = {}) => ({
  "x-api-key": KEY,
  "x-timestamp": String(Math.floor(Date.now() / 1000)),
  "x-nonce": randomBytes(12).toString("hex"),
  ...over,
});

describe("GET /status (FR7, SR13)", () => {
  it("is public and reports every chain", async () => {
    const { app } = setup();
    const res = await request(app).get("/status");
    expect(res.status).toBe(200);
    expect(res.body.chains).toHaveLength(2);
    expect(res.body.allChainsConnected).toBe(true);
    expect(res.body.warnings).toEqual([]);
  });
  it("warns when a balance is low and when a chain is down", async () => {
    const { app } = setup({ xrpl: fakeXrpl({ balance: "5" }), evm: fakeEvm({ down: true }) });
    const res = await request(app).get("/status");
    expect(res.body.allChainsConnected).toBe(false);
    expect(res.body.warnings[0]).toMatch(/Low balance on xrpl/);
  });
});

describe("authentication and replay protection (SR1, SR4, SR13)", () => {
  it("rejects requests without a valid API key", async () => {
    const { app } = setup();
    expect((await request(app).get("/records/evm/123e4567-e89b-12d3-a456-426614174000")).status).toBe(401);
    expect((await request(app).post("/records").set(write({ "x-api-key": "wrong" })).send({ chain: "evm", payload: "x" })).status).toBe(401);
  });
  it("requires a timestamp and a nonce on writes", async () => {
    const { app } = setup();
    const res = await request(app).post("/records").set({ "x-api-key": KEY }).send({ chain: "evm", payload: "x" });
    expect(res.status).toBe(400);
  });
  it("rejects an old request", async () => {
    const { app } = setup();
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect((await request(app).post("/records").set(write({ "x-timestamp": old })).send({ chain: "evm", payload: "x" })).status).toBe(401);
  });
  it("rejects a repeated nonce (replay)", async () => {
    const { app } = setup();
    const headers = write();
    expect((await request(app).post("/records").set(headers).send({ chain: "evm", payload: "x" })).status).toBe(201);
    const replay = await request(app).post("/records").set(headers).send({ chain: "evm", payload: "x" });
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe("repeated_nonce");
  });
  it("limits the number of writes per minute", async () => {
    const { app } = setup({ rate: 2 });
    for (let i = 0; i < 2; i++) expect((await request(app).post("/records").set(write()).send({ chain: "evm", payload: "x" })).status).toBe(201);
    const res = await request(app).post("/records").set(write()).send({ chain: "evm", payload: "x" });
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });
});

describe("records on one chain (FR1-FR4)", () => {
  it.each(["xrpl", "evm"] as const)("stores and reads a record on %s with the same format", async (chain) => {
    const { app } = setup();
    const payload = '{"temperature": 21.5}';
    const created = await request(app).post("/records").set(write()).send({ chain, payload });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ chain, contentHash: sha256Hex(payload) });
    const read = await request(app).get(`/records/${chain}/${created.body.id}`).set({ "x-api-key": KEY });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: created.body.id, chain, payload, contentHash: sha256Hex(payload) });
  });
  it("validates the input", async () => {
    const { app } = setup();
    expect((await request(app).post("/records").set(write()).send({ chain: "bitcoin", payload: "x" })).status).toBe(400);
    expect((await request(app).post("/records").set(write()).send({ chain: "evm", payload: "" })).status).toBe(400);
    expect((await request(app).get("/records/evm/not-a-uuid").set({ "x-api-key": KEY })).status).toBe(400);
  });
  it("rejects a payload over the limit of the chain (SR2)", async () => {
    const { app } = setup();
    const res = await request(app).post("/records").set(write()).send({ chain: "xrpl", payload: "x".repeat(513) });
    expect(res.status).toBe(413);
  });
  it("returns 404 for an unknown record or a record of the other chain", async () => {
    const { app } = setup();
    const created = await request(app).post("/records").set(write()).send({ chain: "evm", payload: "x" });
    expect((await request(app).get(`/records/xrpl/${created.body.id}`).set({ "x-api-key": KEY })).status).toBe(404);
    expect((await request(app).get("/records/evm/123e4567-e89b-12d3-a456-426614174000").set({ "x-api-key": KEY })).status).toBe(404);
  });
  it("returns 503 when the chain is not available", async () => {
    const { app } = setup({ evm: fakeEvm({ down: true }) });
    const res = await request(app).post("/records").set(write()).send({ chain: "evm", payload: "x" });
    expect(res.status).toBe(503);
  });
});

describe("cross-chain operation (FR5, FR6)", () => {
  it("stores on the EVM chain, anchors the hash on the XRP Ledger and verifies it", async () => {
    const { app, xrpl } = setup();
    const payload = '{"invoice": 42}';
    const res = await request(app).post("/records/cross-chain").set(write()).send({ payload });
    expect(res.status).toBe(201);
    expect(res.body.state).toBe("completed");
    expect(res.body.refs.map((r: { chain: string }) => r.chain).sort()).toEqual(["evm", "xrpl"]);
    // The anchor carries all the fields needed to verify it without the API (SR11).
    const anchor = xrpl.anchors.get(res.body.id)!.data;
    expect(anchor).toMatchObject({ hash: sha256Hex(payload), id: res.body.id, evmChainId: 1449000 });

    const read = await request(app).get(`/records/cross-chain/${res.body.id}`).set({ "x-api-key": KEY });
    expect(read.body).toMatchObject({ payload, state: "completed" });

    const verify = await request(app).get(`/records/cross-chain/${res.body.id}/verify`).set({ "x-api-key": KEY });
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ valid: true, storedHash: sha256Hex(payload), anchoredHash: sha256Hex(payload) });
  });

  it("detects a record that does not match its anchor", async () => {
    const { app, evm } = setup();
    const res = await request(app).post("/records/cross-chain").set(write()).send({ payload: "original" });
    evm.tamper(res.body.id, "modified");
    const verify = await request(app).get(`/records/cross-chain/${res.body.id}/verify`).set({ "x-api-key": KEY });
    expect(verify.body.valid).toBe(false);
    expect(verify.body.storedHash).toBe(sha256Hex("modified"));
    expect(verify.body.anchoredHash).toBe(sha256Hex("original"));
  });

  it("answers 202 when the anchor cannot be written and completes it later", async () => {
    const { app, service, xrpl } = setup({ xrpl: fakeXrpl({ failAnchors: 1 }) });
    const res = await request(app).post("/records/cross-chain").set(write()).send({ payload: "x" });
    expect(res.status).toBe(202);
    expect(res.body.state).toBe("pending_anchor");
    expect((await request(app).get("/status")).body.warnings).toContain("1 cross-chain record(s) waiting for their anchor");
    expect(await service.retryPendingAnchors()).toBe(1);
    const read = await request(app).get(`/records/cross-chain/${res.body.id}`).set({ "x-api-key": KEY });
    expect(read.body.state).toBe("completed");
    expect(xrpl.anchorsWritten).toBe(1);
  });

  it("never anchors a record twice when the first anchor was written but not confirmed", async () => {
    const { app, service, xrpl } = setup({ xrpl: fakeXrpl({ failAnchors: 1, anchorButReportFailure: true }) });
    const res = await request(app).post("/records/cross-chain").set(write()).send({ payload: "x" });
    expect(res.body.state).toBe("pending_anchor");
    await service.retryPendingAnchors();
    expect(xrpl.anchorsWritten).toBe(1);
    const read = await request(app).get(`/records/cross-chain/${res.body.id}`).set({ "x-api-key": KEY });
    expect(read.body.state).toBe("completed");
  });

  it("marks the operation as failed when the EVM chain is not available", async () => {
    const { app } = setup({ evm: fakeEvm({ down: true }) });
    const res = await request(app).post("/records/cross-chain").set(write()).send({ payload: "x" });
    expect(res.status).toBe(503);
  });
});
