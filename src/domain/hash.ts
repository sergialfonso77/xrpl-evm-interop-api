import { createHash } from "node:crypto";

/**
 * SHA-256 hash of a payload, computed over its UTF-8 bytes exactly as received.
 * The payload is never reformatted, so that anyone can recompute the same hash (Section 3.2.2).
 */
export function sha256Hex(payload: string): string {
  return createHash("sha256").update(Buffer.from(payload, "utf8")).digest("hex");
}

/** Size of a payload in bytes, used to apply the limits of SR2. */
export function payloadSize(payload: string): number {
  return Buffer.byteLength(payload, "utf8");
}
