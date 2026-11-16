import { z } from "zod";

/**
 * Configuration of the API, read from environment variables (SR3: no secrets in the code).
 * Each variable is validated at start-up, so that a wrong configuration fails early.
 */
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  // Comma-separated list of API keys accepted by the API (SR1).
  API_KEYS: z.string().min(1).transform((v) => v.split(",").map((k) => k.trim()).filter(Boolean)),
  // Maximum age of a request timestamp, in seconds (SR4).
  REQUEST_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(300),
  // Write requests allowed per client and minute (SR13).
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),
  // Size limits of the payload in bytes (SR2).
  MAX_XRPL_PAYLOAD_BYTES: z.coerce.number().int().positive().default(512),
  MAX_EVM_PAYLOAD_BYTES: z.coerce.number().int().positive().default(4096),

  // XRP Ledger (local rippled in stand-alone mode or XRPL Testnet).
  XRPL_WS_URL: z.string().url(),
  XRPL_SEED: z.string().min(1),
  // Second account of the API that receives the minimal payments used to carry memos.
  XRPL_ANCHOR_DESTINATION: z.string().min(1),
  // true only for a local rippled in stand-alone mode (the adapter closes the ledgers itself).
  XRPL_STANDALONE: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),

  // EVM chain (local Anvil or XRPL EVM testnet).
  EVM_RPC_URL: z.string().url(),
  EVM_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex key"),
  EVM_CHAIN_ID: z.coerce.number().int().positive(),
  // Address of the RecordStore contract of the API, written after it is deployed (empty until then).
  EVM_CONTRACT_ADDRESS: z.preprocess((v) => (v === "" ? undefined : v), z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional()),
  // Block in which the contract was deployed: searches without a transaction reference start there.
  EVM_FROM_BLOCK: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().nonnegative().default(0)),

  // Local store (SQLite).
  DB_PATH: z.string().default("./data/api.sqlite"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
