import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { logger } from "@aktenraum/core";

import type { AsyncQueue } from "./queue.js";
import type { ProcessingState } from "./processing-state.js";

export type Trigger = "extract" | "propagate" | "reindex-metadata";

export function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!expected) return true;
  if (provided === undefined) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export interface WebhookDeps {
  extractionQueue: AsyncQueue<number>;
  propagationQueue: AsyncQueue<number>;
  indexingQueue: AsyncQueue<number>;
  processingState: ProcessingState;
  webhookSecret: string;
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

const TRIGGER_QUEUES: Record<Trigger, keyof Pick<WebhookDeps, "extractionQueue" | "propagationQueue" | "indexingQueue">> = {
  extract: "extractionQueue",
  propagate: "propagationQueue",
  "reindex-metadata": "indexingQueue",
};

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

  if (url.pathname === "/processing" && req.method === "GET") {
    const secret = req.headers["x-aktenraum-secret"];
    if (!secretMatches(typeof secret === "string" ? secret : undefined, deps.webhookSecret)) {
      json(401, { detail: "Bad secret" });
      return;
    }
    json(200, {
      processing: deps.processingState.activeIds(),
      slots: deps.processingState.snapshot(),
    });
    return;
  }

  const match = /^\/trigger\/(extract|propagate|reindex-metadata)$/.exec(url.pathname);
  if (match !== null && req.method === "POST") {
    const secret = req.headers["x-aktenraum-secret"];
    if (!secretMatches(typeof secret === "string" ? secret : undefined, deps.webhookSecret)) {
      json(401, { detail: "Bad secret" });
      return;
    }
    const docId = parseDocumentId(await readBody(req));
    if (docId === null) {
      json(400, { detail: "document_id is required" });
      return;
    }
    const trigger = match[1] as Trigger;
    deps[TRIGGER_QUEUES[trigger]].push(docId);
    logger.info("webhook_enqueued", { trigger, doc_id: docId });
    json(200, { queued: docId, trigger });
    return;
  }

  json(404, { detail: "Not found" });
}
