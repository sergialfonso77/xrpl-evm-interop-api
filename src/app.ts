import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type Database from "better-sqlite3";
import { z } from "zod";
import { IntegrityError } from "./adapters/evm.js";
import { PayloadTooLargeError } from "./adapters/xrpl.js";
import { ChainError, NotFoundError, type RecordService } from "./service.js";
import { createSecurity, sendError, type SecurityOptions } from "./http/security.js";

export interface AppDeps {
  service: RecordService;
  db: Database.Database;
  security: SecurityOptions;
}

const storeBody = z.object({ chain: z.enum(["xrpl", "evm"]), payload: z.string().min(1) }).strict();
const crossBody = z.object({ payload: z.string().min(1) }).strict();
const chainParam = z.enum(["xrpl", "evm"]);
// Identifiers are UUIDs; they are compared in lower case, as the API generates them.
const idParam = z.string().uuid().transform((s) => s.toLowerCase());

/** Wraps an async route so that its errors reach the error handler. */
const route = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

/** Express application: REST interface of the API (Section 3.2.3, Table of the interface). */
export function createApp(deps: AppDeps): Express {
  const { service } = deps;
  const { authenticate, protectWrite } = createSecurity(deps.db, deps.security);
  const app = express();
  app.disable("x-powered-by");

  // FR7: public status of the API and of each chain.
  app.get(
    "/status",
    route(async (_req, res) => {
      const { chains, warnings } = await service.status();
      res.status(200).json({ api: "ok", chains, allChainsConnected: chains.every((c) => c.connected), warnings });
    }),
  );

  // The API key is checked before the body is read, so that requests without credentials are
  // always answered with 401 and their body is never parsed (SR1).
  app.use("/records", authenticate);
  app.use(express.json({ limit: "16kb" }));

  // The cross-chain routes are declared first, so that "cross-chain" is not taken as a chain name.
  app.post(
    "/records/cross-chain",
    protectWrite,
    route(async (req, res) => {
      const body = crossBody.safeParse(req.body);
      if (!body.success) return sendError(res, 400, "bad_request", "Body must be {\"payload\": string}");
      const result = await service.crossChain(body.data.payload);
      res.status(result.state === "completed" ? 201 : 202).json(result);
    }),
  );

  app.get(
    "/records/cross-chain/:id",
    route(async (req, res) => {
      const id = idParam.safeParse(req.params.id);
      if (!id.success) return sendError(res, 400, "bad_request", "The identifier must be a UUID");
      res.status(200).json(await service.getCrossChain(id.data));
    }),
  );

  app.get(
    "/records/cross-chain/:id/verify",
    route(async (req, res) => {
      const id = idParam.safeParse(req.params.id);
      if (!id.success) return sendError(res, 400, "bad_request", "The identifier must be a UUID");
      res.status(200).json(await service.verify(id.data));
    }),
  );

  app.post(
    "/records",
    protectWrite,
    route(async (req, res) => {
      const body = storeBody.safeParse(req.body);
      if (!body.success) return sendError(res, 400, "bad_request", "Body must be {\"chain\": \"xrpl\" | \"evm\", \"payload\": string}");
      res.status(201).json(await service.store(body.data.chain, body.data.payload));
    }),
  );

  app.get(
    "/records/:chain/:id",
    route(async (req, res) => {
      const chain = chainParam.safeParse(req.params.chain);
      const id = idParam.safeParse(req.params.id);
      if (!chain.success || !id.success) return sendError(res, 400, "bad_request", "Chain must be xrpl or evm and the identifier a UUID");
      res.status(200).json(await service.get(chain.data, id.data));
    }),
  );

  // Unknown routes also answer with the common JSON format.
  app.use((_req: Request, res: Response) => sendError(res, 404, "not_found", "Unknown route"));

  // Errors of the body parser and of the service, with the codes of the interface.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === "entity.too.large") return sendError(res, 413, "payload_too_large", "Request body too large");
    if (e?.type === "entity.parse.failed") return sendError(res, 400, "bad_request", "Invalid JSON");
    if (err instanceof PayloadTooLargeError) return sendError(res, 413, "payload_too_large", err.message);
    if (err instanceof NotFoundError) return sendError(res, 404, "not_found", err.message);
    if (err instanceof IntegrityError) return sendError(res, 502, "integrity_error", err.message);
    if (err instanceof ChainError) return sendError(res, 503, "chain_unavailable", err.message);
    console.error(err);
    sendError(res, 500, "internal_error", "Internal error");
  });

  return app;
}
