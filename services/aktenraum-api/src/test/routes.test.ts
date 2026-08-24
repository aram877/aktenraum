import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";

import { hashPassword } from "../auth/passwords.js";
import { users } from "../db/schema.js";
import type { PaperlessGateway } from "../paperless/paperless.gateway.js";
import { FakeGateway, TAGS, makeDoc } from "./fake-gateway.js";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness | null = null;
let gateway: FakeGateway;
let agent: ReturnType<typeof request.agent>;

async function boot(options: { gateway?: FakeGateway } = {}): Promise<void> {
  gateway = options.gateway ?? new FakeGateway();
  harness = await createHarness({ gateway: gateway as unknown as Partial<PaperlessGateway> });
  await harness.db
    .insert(users)
    .values({ username: "admin", passwordHash: await hashPassword("correct-horse") });
  agent = request.agent(harness.app.getHttpServer());
  await agent.post("/api/auth/login").send({ username: "admin", password: "correct-horse" });
}

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("inbox routes", () => {
  beforeEach(async () => {
    await boot();
  });

  it("lists only ai-pending documents", async () => {
    const response = await agent.get("/api/inbox/");
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.results[0].id).toBe(42);
  });

  it("returns the full detail payload", async () => {
    const response = await agent.get("/api/inbox/42");
    expect(response.status).toBe(200);
    expect(response.body.ai_correspondent).toBe("Stadtwerke München");
    expect(response.body.tags).toEqual(["ai-pending", "wichtig"]);
    expect(response.body.content_excerpt).toContain("Sehr geehrte");
  });

  it("404s on an unknown document", async () => {
    const response = await agent.get("/api/inbox/999");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ detail: "Document 999 not found" });
  });

  it("patches only the supplied fields and leaves the rest intact", async () => {
    const response = await agent.patch("/api/inbox/42").send({ ai_title: "Neuer Titel" });
    expect(response.status).toBe(200);
    expect(response.body.ai_title).toBe("Neuer Titel");
    expect(response.body.ai_correspondent).toBe("Stadtwerke München");
    expect(response.body.ai_summary_de).toBe("Eine Stromrechnung.");
  });

  it("approves by swapping pending for approved and keeps unrelated tags", async () => {
    const response = await agent.post("/api/inbox/42/approve").send({});
    expect(response.status).toBe(200);
    expect(response.body.tags).toEqual(["wichtig", "ai-approved"]);
  });

  it("is idempotent when re-approving", async () => {
    await agent.post("/api/inbox/42/approve").send({});
    const second = await agent.post("/api/inbox/42/approve").send({});
    expect(second.status).toBe(200);
    expect(second.body.tags).toEqual(["wichtig", "ai-approved"]);
  });

  it("applies a field patch supplied with the approve call", async () => {
    const response = await agent
      .post("/api/inbox/42/approve")
      .send({ ai_title: "Vor Genehmigung korrigiert" });
    expect(response.body.ai_title).toBe("Vor Genehmigung korrigiert");
  });

  it("rejects by swapping pending for rejected", async () => {
    const response = await agent.post("/api/inbox/42/reject");
    expect(response.status).toBe(200);
    expect(response.body.tags).toContain("ai-rejected");
  });

  it("streams the preview with the private cache header", async () => {
    const response = await agent.get("/api/inbox/42/preview");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/pdf");
    expect(response.headers["cache-control"]).toBe("private, max-age=300");
  });

  it("requires authentication", async () => {
    const anonymous = await request(harness!.app.getHttpServer()).get("/api/inbox/");
    expect(anonymous.status).toBe(401);
  });
});

describe("library routes", () => {
  it("excludes ai-pending documents entirely", async () => {
    await boot();
    const response = await agent.get("/api/library/");
    expect(response.status).toBe(200);
    expect(response.body.results).toEqual([]);
    expect(response.body.total).toBe(0);
  });

  it("shows a propagated document with its badge and user tags split", async () => {
    await boot({
      gateway: new FakeGateway({
        docs: [makeDoc({ tags: [TAGS["ai-propagated"] as number, TAGS.wichtig as number] })],
      }),
    });
    const response = await agent.get("/api/library/");
    expect(response.body.results[0].lifecycle_tags).toEqual(["ai-propagated"]);
    expect(response.body.results[0].tags).toEqual(["wichtig"]);
    expect(response.body.results[0].correspondent).toBe("Stadtwerke München");
  });

  it("rejects an ordering value outside the allowlist", async () => {
    await boot();
    const response = await agent.get("/api/library/?ordering=bogus");
    expect(response.status).toBe(422);
  });

  it("returns an empty page when a requested tag does not exist", async () => {
    await boot({
      gateway: new FakeGateway({ docs: [makeDoc({ tags: [TAGS["ai-propagated"] as number] })] }),
    });
    const response = await agent.get("/api/library/?tags=gibtsnicht");
    expect(response.body.total).toBe(0);
  });

  it("filters by a real tag with AND semantics", async () => {
    await boot({
      gateway: new FakeGateway({
        docs: [makeDoc({ tags: [TAGS["ai-propagated"] as number, TAGS.wichtig as number] })],
      }),
    });
    const response = await agent.get("/api/library/?tags=wichtig");
    expect(response.body.results).toHaveLength(1);
  });
});

describe("documents routes", () => {
  beforeEach(async () => {
    await boot();
  });

  it("serves the shared detail payload", async () => {
    const response = await agent.get("/api/documents/42/detail");
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(42);
  });

  it("patches fields from the library page", async () => {
    const response = await agent
      .patch("/api/documents/42/fields")
      .send({ ai_summary_de: "Von der Bibliothek bearbeitet." });
    expect(response.body.ai_summary_de).toBe("Von der Bibliothek bearbeitet.");
  });

  it("reprocess clears every lifecycle and auxiliary tag", async () => {
    const response = await agent.post("/api/documents/42/reprocess");
    expect(response.status).toBe(200);
    expect(response.body.cleared_tags).toContain("ai-pending");
    expect(response.body.cleared_tags).toContain("ai-auto-approved");
    expect(response.body.auto_tagger_notified).toBe(false);
    expect(gateway.docs.get(42)!.tags).toEqual([TAGS.wichtig]);
  });

  it("proxies the preview and the download with the right headers", async () => {
    const preview = await agent.get("/api/documents/42/preview");
    expect(preview.headers["cache-control"]).toBe("private, max-age=300");

    const download = await agent.get("/api/documents/42/download");
    expect(download.headers["cache-control"]).toBe("private, no-store");
    expect(download.headers["content-disposition"]).toContain("rechnung.pdf");
  });
});

describe("upload routes", () => {
  beforeEach(async () => {
    await boot();
  });

  it("isolates per-file failures across a mixed batch", async () => {
    const response = await agent
      .post("/api/documents/upload")
      .attach("files", Buffer.from("%PDF-1.4 ok"), {
        filename: "good.pdf",
        contentType: "application/pdf",
      })
      .attach("files", Buffer.from("MZ"), {
        filename: "bad.exe",
        contentType: "application/x-msdownload",
      })
      .attach("files", Buffer.alloc(0), {
        filename: "empty.pdf",
        contentType: "application/pdf",
      });

    expect(response.status).toBe(200);
    const byName = Object.fromEntries(
      (response.body.results as { filename: string; status: string; detail?: string }[]).map(
        (r) => [r.filename, r],
      ),
    );
    expect(byName["good.pdf"]?.status).toBe("accepted");
    expect(byName["bad.exe"]?.status).toBe("error");
    expect(byName["bad.exe"]?.detail).toContain("Unsupported content-type");
    expect(byName["empty.pdf"]?.detail).toBe("Empty file");
    expect(gateway.uploads).toHaveLength(1);
  });

  it("rejects a request with no files", async () => {
    const response = await agent.post("/api/documents/upload").field("title", "x");
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ detail: "No files supplied" });
  });

  it("returns 413 when the batch exceeds the per-request file cap", async () => {
    let call = agent.post("/api/documents/upload");
    for (let i = 0; i < 21; i += 1) {
      call = call.attach("files", Buffer.from("%PDF"), {
        filename: `f${i}.pdf`,
        contentType: "application/pdf",
      });
    }
    const response = await call;
    expect(response.status).toBe(413);
  });
});

describe("trash routes", () => {
  beforeEach(async () => {
    await boot();
  });

  it("moves a document to trash, lists it, and restores it", async () => {
    expect((await agent.delete("/api/documents/42")).status).toBe(204);

    const listed = await agent.get("/api/trash/");
    expect(listed.body.total).toBe(1);
    expect(listed.body.results[0].deleted_at).toBe("2026-08-01T09:00:00.000Z");

    expect((await agent.post("/api/trash/42/restore")).status).toBe(204);
    expect((await agent.get("/api/trash/")).body.total).toBe(0);
  });

  it("uses trash-specific wording on a 404", async () => {
    const response = await agent.post("/api/trash/999/restore");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ detail: "Document 999 not in trash" });
  });

  it("hard-deletes a single document", async () => {
    await agent.delete("/api/documents/42");
    expect((await agent.post("/api/trash/42/delete")).status).toBe(204);
    expect(gateway.emptyTrashCalls).toEqual([[42]]);
    expect((await agent.get("/api/trash/")).body.total).toBe(0);
  });

  it("empties the whole trash and reports the count", async () => {
    await agent.delete("/api/documents/42");
    const response = await agent.post("/api/trash/empty");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ emptied: 1 });
  });

  it("reports zero on an already-empty trash without calling Paperless", async () => {
    const response = await agent.post("/api/trash/empty");
    expect(response.body).toEqual({ emptied: 0 });
    expect(gateway.emptyTrashCalls).toEqual([]);
  });
});

describe("settings routes", () => {
  beforeEach(async () => {
    await boot();
  });

  it("reads and writes the extraction model", async () => {
    expect((await agent.get("/api/settings/llm")).body).toEqual({
      model: "qwen2.5:14b-instruct-q8_0",
    });
    const patched = await agent.patch("/api/settings/llm").send({ model: "  qwen3:8b  " });
    expect(patched.body).toEqual({ model: "qwen3:8b" });
  });

  it("keeps the answer model independent of the extraction model", async () => {
    await agent.patch("/api/settings/llm").send({ model: "qwen3:8b" });
    expect((await agent.get("/api/settings/answer-llm")).body).toEqual({
      model: "qwen2.5:14b-instruct-q8_0",
    });
  });

  it("rejects an empty model tag", async () => {
    const response = await agent.patch("/api/settings/llm").send({ model: "   " });
    expect(response.status).toBe(422);
  });

  it("reconciles a rule row for every document type on startup", async () => {
    const response = await agent.get("/api/settings/auto-approve");
    expect(response.body.rules).toHaveLength(27);
    expect(response.body.rules.some((r: { document_type: string }) => r.document_type === "Beleg")).toBe(
      true,
    );
  });

  it("rejects a partial auto-approve payload", async () => {
    const current = (await agent.get("/api/settings/auto-approve")).body.rules as {
      document_type: string;
    }[];
    const partial = current.slice(0, -1).map((r) => ({
      document_type: r.document_type,
      enabled: false,
      min_confidence: 0.9,
    }));
    const response = await agent.put("/api/settings/auto-approve").send({ rules: partial });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toContain("Missing document_type entries");
  });

  it("rejects duplicated entries", async () => {
    const current = (await agent.get("/api/settings/auto-approve")).body.rules as {
      document_type: string;
    }[];
    const rules = current.map((r) => ({
      document_type: r.document_type,
      enabled: false,
      min_confidence: 0.9,
    }));
    rules.push(rules[0]!);
    const response = await agent.put("/api/settings/auto-approve").send({ rules });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toContain("Duplicate document_type entries");
  });

  it("applies a full-set replacement and stamps the editing user", async () => {
    const current = (await agent.get("/api/settings/auto-approve")).body.rules as {
      document_type: string;
    }[];
    const rules = current.map((r) => ({
      document_type: r.document_type,
      enabled: r.document_type === "Rechnung",
      min_confidence: r.document_type === "Rechnung" ? 0.95 : 0.9,
    }));
    const response = await agent.put("/api/settings/auto-approve").send({ rules });
    expect(response.status).toBe(200);
    const rechnung = (response.body.rules as { document_type: string; enabled: boolean; min_confidence: number; updated_by: string; updated_at: string }[]).find(
      (r) => r.document_type === "Rechnung",
    )!;
    expect(rechnung.enabled).toBe(true);
    expect(rechnung.min_confidence).toBe(0.95);
    expect(rechnung.updated_by).toBe("admin");
    expect(Number.isNaN(new Date(rechnung.updated_at).getTime())).toBe(false);
  });
});

describe("secret-gated internal endpoints", () => {
  it("are open when no WEBHOOK_SECRET is configured", async () => {
    await boot();
    const response = await request(harness!.app.getHttpServer()).get(
      "/api/settings/active-llm-model",
    );
    expect(response.status).toBe(200);
    expect(response.body.ollama_model).toBe("qwen2.5:14b-instruct-q8_0");
  });

  it("reject a missing or wrong secret once one is configured", async () => {
    gateway = new FakeGateway();
    harness = await createHarness({
      gateway: gateway as unknown as Partial<PaperlessGateway>,
      env: { WEBHOOK_SECRET: "topsecret" },
    });
    const server = harness.app.getHttpServer();

    expect((await request(server).get("/api/settings/active-llm-model")).status).toBe(401);
    expect(
      (
        await request(server)
          .get("/api/settings/active-llm-model")
          .set("X-Aktenraum-Secret", "wrong")
      ).status,
    ).toBe(401);
    const ok = await request(server)
      .get("/api/settings/active-auto-approve-rules")
      .set("X-Aktenraum-Secret", "topsecret");
    expect(ok.status).toBe(200);
    expect(ok.body.rules).toHaveLength(27);
  });
});

describe("health", () => {
  it("is reachable without auth", async () => {
    await boot();
    const response = await request(harness!.app.getHttpServer()).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});

describe("service-unavailable behaviour without a Paperless token", () => {
  it("503s the Paperless-backed routes while auth and health stay green", async () => {
    harness = await createHarness({ gateway: null });
    await harness.db
      .insert(users)
      .values({ username: "admin", passwordHash: await hashPassword("correct-horse") });
    const localAgent = request.agent(harness.app.getHttpServer());
    await localAgent
      .post("/api/auth/login")
      .send({ username: "admin", password: "correct-horse" });

    expect((await localAgent.get("/api/health")).status).toBe(200);
    expect((await localAgent.get("/api/auth/me")).status).toBe(200);

    const library = await localAgent.get("/api/library/");
    expect(library.status).toBe(503);
    expect(library.body).toEqual({ detail: "Paperless API token not configured" });
    expect((await localAgent.get("/api/inbox/")).status).toBe(503);
  });
});
