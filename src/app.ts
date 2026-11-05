import express, { type Express } from "express";
import type { ChainAdapter } from "./adapters/chain.js";

export interface AppDeps {
  adapters: ChainAdapter[];
}

/**
 * Creates the Express application. Routes for records are added in the next tasks
 * (T3.2--T3.4); in T3.1 only the status endpoint is available (FR7).
 */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  app.get("/status", async (_req, res) => {
    const chains = await Promise.all(
      deps.adapters.map((a) =>
        a.status().catch((e: unknown) => ({ chain: a.name, connected: false, error: String(e) })),
      ),
    );
    const ok = chains.every((c) => c.connected);
    res.status(200).json({ api: "ok", chains, allChainsConnected: ok });
  });

  return app;
}
