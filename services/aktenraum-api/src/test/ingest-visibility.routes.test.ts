import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { hashPassword } from "../auth/passwords.js";
import { uploadTasks, users } from "../db/schema.js";
import { EventsService } from "../events/events.service.js";
import { PaperlessRequestError } from "../paperless/errors.js";
import type { PaperlessGateway } from "../paperless/paperless.gateway.js";
import { FakeGateway, TAGS, makeDoc } from "./fake-gateway.js";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness | null = null;
let gateway: FakeGateway;
let agent: ReturnType<typeof request.agent>;

async function boot(fake: FakeGateway): Promise<void> {
  gateway = fake;
  harness = await createHarness({ gateway: gateway as unknown as Partial<PaperlessGateway> });
  await harness.db
    .insert(users)
    .values({ username: "admin", passwordHash: await hashPassword("correct-horse") });
  agent = request.agent(harness.app.getHttpServer());
  await agent.post("/api/auth/login").send({ username: "admin", password: "correct-horse" });
}

// Reprocess pings the auto-tagger over global fetch; the test env falls back
// to http://auto-tagger:8001, whose DNS lookup can outlast the test timeout.
const autoTaggerPings: string[] = [];
beforeEach(() => {
  autoTaggerPings.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      autoTaggerPings.push(String(url));
      if (String(url).endsWith("/processing")) {
        return Response.json({ processing: [3], slots: {} });
      }
      return new Response(null, { status: 202 });
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await harness?.close();
  harness = null;
});

const tag = (name: string): number => TAGS[name] as number;

function tagsOf(docId: number): number[] {
  return (gateway.docs.get(docId)?.tags as number[]) ?? [];
}

// A function, not a constant: the fake gateway mutates tags in place.
const mixedDocs = (): ReturnType<typeof makeDoc>[] => [
  makeDoc({ id: 1, tags: [tag("ai-error")] }),
  makeDoc({ id: 2, tags: [tag("ai-propagation-error"), tag("wichtig")] }),
  makeDoc({ id: 3, tags: [tag("ai-propagated")] }),
  makeDoc({ id: 4, tags: [] }),
  makeDoc({ id: 5, tags: [tag("ai-rejected")] }),
  makeDoc({ id: 6, tags: [tag("ai-pending")] }),
  makeDoc({ id: 7, tags: [tag("ai-approved")] }),
];

function ids(body: { results: { id: number }[] }): number[] {
  return body.results.map((r) => r.id).sort((a, b) => a - b);
}

describe("library status filter", () => {
  it.each([
    ["error", [1, 2]],
    ["unprocessed", [4]],
    ["approved", [7]],
    ["done", [3]],
    ["rejected", [5]],
  ])("status=%s returns only matching documents", async (status, expected) => {
    await boot(new FakeGateway({ docs: mixedDocs() }));
    const response = await agent.get(`/api/library/?status=${status}`);
    expect(response.status).toBe(200);
    expect(ids(response.body)).toEqual(expected);
  });

  it("combines status with a user tag filter", async () => {
    await boot(new FakeGateway({ docs: mixedDocs() }));
    const response = await agent.get("/api/library/?status=error&tags=wichtig");
    expect(ids(response.body)).toEqual([2]);
  });

  it("pins in-flight rows only when no status is set", async () => {
    await boot(new FakeGateway({ docs: mixedDocs() }));
    const unfiltered = await agent.get("/api/library/");
    expect(unfiltered.body.results[0]).toMatchObject({ id: 3, is_processing: true });

    const filtered = await agent.get("/api/library/?status=error");
    expect(filtered.body.results.some((r: { is_processing: boolean }) => r.is_processing)).toBe(false);
  });

  it("rejects an unknown status with 422", async () => {
    await boot(new FakeGateway({ docs: mixedDocs() }));
    expect((await agent.get("/api/library/?status=foo")).status).toBe(422);
  });

  it("returns an empty page when no error tag exists yet", async () => {
    const fake = new FakeGateway({ docs: mixedDocs() });
    const withoutErrors = Object.fromEntries(
      Object.entries(TAGS).filter(([name]) => !name.endsWith("-error")),
    );
    fake.listTags = async () => withoutErrors;
    await boot(fake);
    const response = await agent.get("/api/library/?status=error");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ results: [], total: 0 });
  });
});

describe("live counts", () => {
  it("counts documents carrying any error tag", async () => {
    await boot(new FakeGateway({ docs: mixedDocs() }));
    const counts = await harness!.app.get(EventsService).computeCounts();
    expect(counts.errors).toBe(2);
  });
});

describe("bulk reprocess of failed documents", () => {
  it("reprocesses every failed document", async () => {
    await boot(new FakeGateway({ docs: mixedDocs() }));
    const response = await agent.post("/api/documents/reprocess-failed");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ requested: 2, reprocessed: 2, failed: [], remaining: 0 });
    expect(autoTaggerPings.filter((u) => u.endsWith("/trigger/extract"))).toHaveLength(2);
    expect(tagsOf(1)).toEqual([]);
    expect(tagsOf(2)).toEqual([tag("wichtig")]);
    expect(tagsOf(3)).toEqual([tag("ai-propagated")]);
  });

  it("keeps going when one document fails", async () => {
    const fake = new FakeGateway({ docs: mixedDocs() });
    fake.failTagPatchFor.add(1);
    await boot(fake);
    const response = await agent.post("/api/documents/reprocess-failed");
    expect(response.body.reprocessed).toBe(1);
    expect(response.body.failed).toEqual([
      { doc_id: 1, detail: "Paperless rejected PATCH for 1" },
    ]);
    expect(tagsOf(2)).toEqual([tag("wichtig")]);
  });

  it("caps one call at 200 and reports the rest", async () => {
    const docs = Array.from({ length: 250 }, (_, i) => makeDoc({ id: 1000 + i, tags: [tag("ai-error")] }));
    await boot(new FakeGateway({ docs }));
    const response = await agent.post("/api/documents/reprocess-failed");
    expect(response.body).toMatchObject({ requested: 200, reprocessed: 200, remaining: 50 });
  });
});

const NOW = new Date();
const minutesAgo = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();

const TASKS: Record<string, unknown>[] = [
  {
    task_id: "t-dup",
    task_file_name: "LOBN_202603.pdf",
    date_created: minutesAgo(10),
    date_done: minutesAgo(9),
    status: "FAILURE",
    result:
      "LOBN_202603.pdf: Not consuming LOBN_202603.pdf: It is a duplicate of Gehaltsabrechnung März 2026 (#3).",
    related_document: "3",
    owner: 3,
  },
  {
    task_id: "t-new",
    task_file_name: "template.pdf",
    date_created: minutesAgo(11),
    date_done: minutesAgo(10),
    status: "SUCCESS",
    result: "Success. New document id 1 created",
    related_document: "1",
    owner: 3,
  },
  {
    task_id: "t-folder",
    task_file_name: "0000020.pdf",
    date_created: minutesAgo(12),
    date_done: minutesAgo(12),
    status: "FAILURE",
    result: "0000020.pdf: Not consuming 0000020.pdf: It is a duplicate of Weg (#999).",
    related_document: "999",
    owner: null,
  },
  {
    task_id: "t-broken",
    task_file_name: "broken.pdf",
    date_created: minutesAgo(13),
    date_done: minutesAgo(13),
    status: "FAILURE",
    result: "broken.pdf: Error occurred while consuming document broken.pdf: PDF is damaged",
    related_document: null,
    owner: 3,
  },
  {
    task_id: "task-uuid-1234",
    task_file_name: "upload.pdf",
    date_created: minutesAgo(1),
    date_done: null,
    status: "STARTED",
    result: null,
    related_document: null,
    owner: 3,
  },
  {
    task_id: "t-old",
    task_file_name: "old.pdf",
    date_created: new Date(NOW.getTime() - 40 * 24 * 3_600_000).toISOString(),
    status: "SUCCESS",
    related_document: "3",
    owner: 3,
  },
];

const MAILS: Record<string, unknown>[] = [
  {
    id: 9,
    subject: "Documents uandi",
    received: minutesAgo(15),
    processed: minutesAgo(8),
    status: "FAILED",
    error:
      "Traceback (most recent call last):\n  File \"x.py\", line 1\ndocuments.consumer.ConsumerError: a.pdf: It is a duplicate of X (#39).\n",
  },
  { id: 1, subject: "Alt", received: "2026-01-01T00:00:00Z", processed: "2026-01-01T00:00:00Z", status: "SUCCESS", error: null },
];

describe("import activity", () => {
  async function bootActivity(): Promise<void> {
    await boot(new FakeGateway({ docs: mixedDocs(), tasks: TASKS, processedMail: MAILS }));
    await harness!.db.insert(uploadTasks).values({ taskId: "task-uuid-1234", fileName: "upload.pdf" });
  }

  it("classifies outcome and source and resolves the documents", async () => {
    await bootActivity();
    const response = await agent.get("/api/ingest/activity?days=7");
    expect(response.status).toBe(200);
    const byId = Object.fromEntries(
      (response.body.items as { task_id: string }[]).map((item) => [item.task_id, item]),
    );

    expect(byId["t-old"]).toBeUndefined();
    expect(byId["t-dup"]).toMatchObject({
      source: "email",
      outcome: "duplicate",
      duplicate_of: { id: 3, title: "Rechnung Stadtwerke", lifecycle_tags: ["ai-propagated"], missing: false },
    });
    expect(byId["t-new"]).toMatchObject({
      outcome: "new",
      document: { id: 1, lifecycle_tags: ["ai-error"], missing: false },
    });
    expect(byId["t-folder"]).toMatchObject({
      source: "folder",
      outcome: "duplicate",
      duplicate_of: { id: 999, title: "Weg", missing: true },
    });
    expect(byId["t-broken"]).toMatchObject({
      outcome: "failed",
      message: "Error occurred while consuming document broken.pdf: PDF is damaged",
    });
    expect(byId["task-uuid-1234"]).toMatchObject({ source: "upload", outcome: "running" });

    expect(response.body.summary).toEqual({
      new: 1,
      duplicate: 2,
      failed: 1,
      running: 1,
      by_source: { email: 3, upload: 1, folder: 1 },
    });
    expect(response.body.items[0].task_id).toBe("task-uuid-1234");
  });

  it("summarises failed mails to the traceback's last line", async () => {
    await bootActivity();
    const response = await agent.get("/api/ingest/activity");
    expect(response.body.mails).toEqual([
      expect.objectContaining({
        id: 9,
        status: "FAILED",
        error_summary: "documents.consumer.ConsumerError: a.pdf: It is a duplicate of X (#39).",
      }),
    ]);
  });

  it("clamps days to 1..30", async () => {
    await bootActivity();
    expect((await agent.get("/api/ingest/activity?days=99")).body.days).toBe(30);
    expect((await agent.get("/api/ingest/activity?days=0")).body.days).toBe(1);
    expect((await agent.get("/api/ingest/activity?days=abc")).body.days).toBe(7);
  });

  it("maps a Paperless failure to 502", async () => {
    await bootActivity();
    gateway.tasksError = new PaperlessRequestError(500, "boom", "http://paperless/api/tasks/");
    const response = await agent.get("/api/ingest/activity");
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ detail: "Paperless is unavailable" });
  });

  it("requires a session", async () => {
    await bootActivity();
    const anonymous = request(harness!.app.getHttpServer());
    expect((await anonymous.get("/api/ingest/activity")).status).toBe(401);
  });

  it("records the task id of an accepted upload", async () => {
    await boot(new FakeGateway({ docs: mixedDocs() }));
    await agent
      .post("/api/documents/upload")
      .attach("files", Buffer.from("%PDF-1.4 ok"), { filename: "good.pdf", contentType: "application/pdf" });
    const rows = await harness!.db.select().from(uploadTasks);
    expect(rows.map((r) => r.taskId)).toEqual(["task-uuid-1234"]);
  });
});

describe("library facets", () => {
  it("keeps pipeline markers out of the tag cloud and the row tags", async () => {
    const marked = [tag("ai-propagated"), tag("ai-duplicate"), tag("ai-duplicate-dismissed"), tag("wichtig")];
    await boot(new FakeGateway({ docs: [makeDoc({ id: 1, tags: marked }), makeDoc({ id: 2, tags: marked })] }));
    const facet = await agent.get("/api/library/tags");
    expect(facet.body.results).toEqual([{ name: "wichtig", count: 2 }]);
    const list = await agent.get("/api/library/");
    expect(list.body.results[0].tags).toEqual(["wichtig"]);
  });

  it("lists document types with counts, largest first, without empty ones", async () => {
    await boot(
      new FakeGateway({
        docs: [
          makeDoc({ id: 1, tags: [tag("ai-propagated")] }),
          makeDoc({ id: 2, tags: [tag("ai-propagated")] }),
          makeDoc({ id: 3, tags: [tag("ai-propagated")], document_type: null }),
        ],
      }),
    );
    const response = await agent.get("/api/library/types");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ results: [{ name: "Rechnung", count: 2 }] });
  });

  it("requires a session", async () => {
    await boot(new FakeGateway({ docs: mixedDocs() }));
    const anonymous = request(harness!.app.getHttpServer());
    expect((await anonymous.get("/api/library/types")).status).toBe(401);
  });
});
