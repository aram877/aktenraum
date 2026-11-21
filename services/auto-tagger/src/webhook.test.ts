import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { ServiceCredentials } from "@aktenraum/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IndexJob } from "./indexer.js";
import { ProcessingState } from "./processing-state.js";
import { AsyncQueue } from "./queue.js";
import { createWebhookServer, type WebhookRoute } from "./webhook.js";

const HOOK = "akt_svc_hook_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WORKER = "akt_svc_worker_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const API = "akt_svc_api_cccccccccccccccccccccccccccccccccccccccc";
const TOKENS: Record<string, string> = { "paperless-hook": HOOK, api: API, worker: WORKER };

const extractionQueue = new AsyncQueue<number>();
const propagationQueue = new AsyncQueue<number>();
const indexingQueue = new AsyncQueue<IndexJob>();
const deps = {
  extractionQueue,
  propagationQueue,
  indexingQueue,
  processingState: new ProcessingState(),
  credentials: {} as ServiceCredentials,
};

let server: Server;
let base: string;

beforeAll(async () => {
  server = createWebhookServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function drain(): Promise<void> {
  while (extractionQueue.size > 0) await extractionQueue.pop();
  while (propagationQueue.size > 0) await propagationQueue.pop();
  while (indexingQueue.size > 0) await indexingQueue.pop();
}

beforeEach(async () => {
  await drain();
  deps.credentials = { "paperless-hook": HOOK, worker: WORKER, api: API };
});

function call(route: WebhookRoute, headers: Record<string, string>): Promise<Response> {
  if (route === "processing") return fetch(`${base}/processing`, { headers });
  return fetch(`${base}/trigger/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ document_id: 42 }),
  });
}

function queued(): number {
  return extractionQueue.size + propagationQueue.size + indexingQueue.size;
}

const ROUTES: WebhookRoute[] = ["extract", "propagate", "reindex-metadata", "processing"];
const EXPECTED: Record<string, Record<WebhookRoute, number>> = {
  "paperless-hook": { extract: 200, propagate: 403, "reindex-metadata": 403, processing: 403 },
  api: { extract: 200, propagate: 200, "reindex-metadata": 200, processing: 200 },
  worker: { extract: 403, propagate: 403, "reindex-metadata": 403, processing: 403 },
};

describe("webhook allowance matrix", () => {
  for (const caller of Object.keys(EXPECTED)) {
    for (const route of ROUTES) {
      const status = EXPECTED[caller]![route];
      it(`${caller} → ${route} = ${status}`, async () => {
        const res = await call(route, { Authorization: `Bearer ${TOKENS[caller]}` });
        expect(res.status).toBe(status);
        if (status !== 200) expect(queued()).toBe(0);
        else if (route !== "processing") expect(queued()).toBe(1);
      });
    }
  }

  for (const route of ROUTES) {
    it(`unknown credential on ${route} = 401`, async () => {
      expect((await call(route, { Authorization: "Bearer akt_svc_unknown" })).status).toBe(401);
      expect(queued()).toBe(0);
    });

    it(`missing credential on ${route} = 401`, async () => {
      expect((await call(route, {})).status).toBe(401);
      expect(queued()).toBe(0);
    });

    it(`old X-Aktenraum-Secret header on ${route} = 401`, async () => {
      expect((await call(route, { "X-Aktenraum-Secret": API })).status).toBe(401);
      expect(queued()).toBe(0);
    });
  }
});

describe("webhook fail-closed configuration", () => {
  it("refuses the hook when its credential is unset but still serves the api", async () => {
    deps.credentials = { "paperless-hook": "", worker: WORKER, api: API };
    expect((await call("extract", { Authorization: "Bearer " })).status).toBe(401);
    expect((await call("extract", { Authorization: `Bearer ${API}` })).status).toBe(200);
  });

  it("refuses a value shared by two credentials", async () => {
    deps.credentials = { "paperless-hook": HOOK, worker: API, api: API };
    expect((await call("propagate", { Authorization: `Bearer ${API}` })).status).toBe(401);
    expect((await call("extract", { Authorization: `Bearer ${HOOK}` })).status).toBe(200);
  });
});

describe("webhook logging", () => {
  it("names the caller on enqueue and on a refusal, never the credential", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await call("extract", { Authorization: `Bearer ${HOOK}` });
      await call("propagate", { Authorization: `Bearer ${HOOK}` });
      await call("propagate", { Authorization: "Bearer akt_svc_unknown" });
      const lines = [...info.mock.calls, ...warn.mock.calls].map((c) => String(c[0]));
      const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(events).toContainEqual(
        expect.objectContaining({ event: "webhook_enqueued", caller: "paperless-hook", trigger: "extract", doc_id: 42 }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ event: "webhook_rejected", reason: "not_allowed", caller: "paperless-hook", route: "propagate" }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ event: "webhook_rejected", reason: "unknown_credential", route: "propagate" }),
      );
      for (const line of lines) {
        expect(line).not.toContain(HOOK);
        expect(line).not.toContain("akt_svc_unknown");
      }
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
});
