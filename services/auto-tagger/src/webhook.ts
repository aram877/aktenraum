import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { logger, serviceCaller, type ServiceCredentials, type ServiceName } from "@aktenraum/core";

import type { IndexJob } from "./indexer.js";
import type { AsyncQueue } from "./queue.js";
import type { ProcessingState } from "./processing-state.js";

export type Trigger = "extract" | "propagate" | "reindex-metadata";
export type WebhookRoute = Trigger | "processing";

/**
 * The worker's whole internal policy (ADR-010 step 5, `service-credentials`):
 * which caller may use which route. A recognised caller outside its row gets
 * 403; an unrecognised credential gets 401.
 */
export const ALLOWED: Record<WebhookRoute, readonly ServiceName[]> = {
  extract: ["paperless-hook", "api"],
  propagate: ["api"],
  "reindex-metadata": ["api"],
  processing: ["api"],
};

export function parseDocumentId(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { document_id?: unknown };
    const raw = parsed.document_id;
    const id = typeof raw === "number" ? raw : Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export const MAX_BODY_BYTES = 64 * 1024;

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface WebhookDeps {
  extractionQueue: AsyncQueue<number>;
  propagationQueue: AsyncQueue<number>;
  indexingQueue: AsyncQueue<IndexJob> | null;
  processingState: ProcessingState;
  /** Hook + api to verify, plus the worker's own (recognised → 403). */
  credentials: ServiceCredentials;
}

export function createWebhookServer(deps: WebhookDeps): Server {
  return createServer((req, res) => {
    void handle(req, res, deps).catch((error: unknown) => {
      logger.error("webhook_handler_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookDeps,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const json = (status: number, payload: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  if (url.pathname === "/health") {
    json(200, { status: "ok" });
    return;
  }

  /** Authenticates and authorises; answers 401/403 itself and returns null on refusal. */
  const admit = (route: WebhookRoute): ServiceName | null => {
    const caller = serviceCaller(req.headers.authorization, deps.credentials);
    if (caller === null) {
      logger.warn("webhook_rejected", { reason: "unknown_credential", route });
      json(401, { detail: "Invalid credential" });
      return null;
    }
    if (!ALLOWED[route].includes(caller)) {
      logger.warn("webhook_rejected", { reason: "not_allowed", caller, route });
      json(403, { detail: "Not allowed" });
      return null;
    }
    return caller;
  };

  if (url.pathname === "/processing" && req.method === "GET") {
    if (admit("processing") === null) return;
    json(200, {
      processing: deps.processingState.activeIds(),
      slots: deps.processingState.snapshot(),
    });
    return;
  }

  const match = /^\/trigger\/(extract|propagate|reindex-metadata)$/.exec(url.pathname);
  if (match !== null && req.method === "POST") {
    const trigger = match[1] as Trigger;
    const caller = admit(trigger);
    if (caller === null) return;
    const body = await readBody(req);
    if (body === null) {
      json(413, { detail: "Body too large" });
      return;
    }
    const docId = parseDocumentId(body);
    if (docId === null) {
      json(400, { detail: "document_id is required" });
      return;
    }
    if (trigger === "extract") deps.extractionQueue.push(docId);
    else if (trigger === "propagate") deps.propagationQueue.push(docId);
    else if (deps.indexingQueue === null) {
      json(503, { detail: "RAG indexing is disabled" });
      return;
    } else deps.indexingQueue.push({ kind: "metadata", docId });
    logger.info("webhook_enqueued", { trigger, doc_id: docId, caller });
    json(200, { queued: docId, trigger });
    return;
  }

  json(404, { detail: "Not found" });
}
