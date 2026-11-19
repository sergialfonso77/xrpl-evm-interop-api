import { createHash, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { NextFunction, Request, Response } from "express";

export interface SecurityOptions {
  apiKeys: string[];
  /** Maximum age of a write request, in seconds (SR4). */
  maxAgeSeconds: number;
  /** Write requests allowed per API key and minute (SR13). */
  ratePerMinute: number;
  /** Clock, replaceable in tests. */
  now?: () => number;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Sends an error with the common format of the API. */
export function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

/**
 * Security of the requests (Section 3.1.4):
 * - SR1: every request to /records needs a valid API key in the X-API-Key header.
 * - SR4: every write request needs X-Timestamp (Unix seconds) and X-Nonce; old requests and
 *   repeated nonces are rejected. Reads are not protected against replay, because repeating
 *   a read does not change anything.
 * - SR13: the number of write requests per API key and minute is limited.
 * Only hashes of the API keys are kept in memory and in the local store.
 */
export function createSecurity(db: Database.Database, opts: SecurityOptions) {
  const keyHashes = opts.apiKeys.map(sha256);
  const now = opts.now ?? (() => Date.now());
  const windows = new Map<string, { start: number; count: number }>();
  const insertNonce = db.prepare("INSERT INTO nonces (api_key_hash, nonce, created_at) VALUES (?, ?, ?)");
  const purgeNonces = db.prepare("DELETE FROM nonces WHERE created_at < ?");

  /** SR1: compares the hash of the key with the configured ones in constant time. */
  function authenticate(req: Request, res: Response, next: NextFunction): void {
    const key = req.header("x-api-key");
    const hash = key ? sha256(key) : undefined;
    if (!hash || !keyHashes.some((h) => timingSafeEqual(h, hash))) {
      return sendError(res, 401, "unauthorized", "Missing or invalid API key");
    }
    res.locals.keyHash = hash.toString("hex");
    next();
  }

  /** SR4 and SR13, only for write requests. */
  function protectWrite(req: Request, res: Response, next: NextFunction): void {
    const keyHash = res.locals.keyHash as string;
    const t = now();

    // SR13: fixed window of one minute per API key.
    const w = windows.get(keyHash);
    if (!w || t - w.start >= 60_000) windows.set(keyHash, { start: t, count: 1 });
    else if (w.count >= opts.ratePerMinute) {
      res.setHeader("Retry-After", String(Math.ceil((w.start + 60_000 - t) / 1000)));
      return sendError(res, 429, "too_many_requests", `Limit of ${opts.ratePerMinute} write requests per minute`);
    } else w.count++;

    // SR4: timestamp within the allowed age and nonce not used before with this key.
    const ts = Number(req.header("x-timestamp"));
    const nonce = req.header("x-nonce") ?? "";
    if (!Number.isInteger(ts) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
      return sendError(res, 400, "bad_request", "X-Timestamp (Unix seconds) and X-Nonce (16-128 characters) are required");
    }
    if (Math.abs(t / 1000 - ts) > opts.maxAgeSeconds) {
      return sendError(res, 401, "stale_request", `The timestamp is more than ${opts.maxAgeSeconds} s away from the time of the server`);
    }
    // Nonces older than twice the maximum age can no longer be replayed, so they are removed.
    purgeNonces.run(Math.floor(t / 1000) - 2 * opts.maxAgeSeconds);
    try {
      insertNonce.run(keyHash, nonce, Math.floor(t / 1000));
    } catch {
      return sendError(res, 409, "repeated_nonce", "This nonce has already been used");
    }
    next();
  }

  return { authenticate, protectWrite };
}
