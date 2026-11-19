import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { documentSpaces, members, spaces, uploadTaskMembers, users } from "../db/schema.js";
import { PaperlessRequestError } from "../paperless/errors.js";
import type { PaperlessGateway } from "../paperless/paperless.gateway.js";
import { FakeGateway, makeDoc } from "../test/fake-gateway.js";
import { createHarness, type Harness } from "../test/harness.js";
import { NO_DOCUMENT } from "./home-space.service.js";
import { TenancyService } from "./tenancy.service.js";

const SECRET = "s3cret-for-tests";

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function setup(tasks: Record<string, unknown>[] = []) {
  const paperless = new FakeGateway({
    docs: [makeDoc({ id: 300 }), makeDoc({ id: 301 }), makeDoc({ id: 302 })],
    tasks,
  });
  harness = await createHarness({
    gateway: paperless as unknown as Partial<PaperlessGateway>,
    env: { WEBHOOK_SECRET: SECRET, BOOTSTRAP_USERNAME: "admin", BOOTSTRAP_PASSWORD: "correct-horse" },
  });
  // A second member with its own personal space.
  await harness.db.insert(users).values({ username: "partner", passwordHash: "x" });
  await harness.app.get(TenancyService).reconcile();
  const all = await harness.db.select().from(members);
  const admin = all.find((m) => m.role === "admin")!;
  const partner = all.find((m) => m.role === "member")!;
  const allSpaces = await harness.db.select().from(spaces);
  const spaceOf = (memberId: number) => allSpaces.find((s) => s.personalMemberId === memberId)!.id;
  const h = harness;
  const assign = (documentId: number) =>
    request(h.app.getHttpServer())
      .post("/api/tenancy/assign-home-space")
      .set("X-Aktenraum-Secret", SECRET)
      .send({ document_id: documentId });
  return { h, paperless, admin, partner, spaceOf, assign };
}

describe("POST /api/tenancy/assign-home-space", () => {
  it("is worker-only: no secret → 401, a logged-in user → 401", async () => {
    const { h } = await setup();
    const server = h.app.getHttpServer();
    await request(server).post("/api/tenancy/assign-home-space").send({ document_id: 300 }).expect(401);
    const agent = request.agent(server);
    await agent.post("/api/auth/login").send({ username: "admin", password: "correct-horse" }).expect(200);
    await agent.post("/api/tenancy/assign-home-space").send({ document_id: 300 }).expect(401);
  });

  it("rejects a malformed body", async () => {
    const { h } = await setup();
    const response = await request(h.app.getHttpServer())
      .post("/api/tenancy/assign-home-space")
      .set("X-Aktenraum-Secret", SECRET)
      .send({ document_id: "300" });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await h.db.select().from(documentSpaces)).toEqual([]);
  });

  it("mail / consume-folder documents go to the household admin's personal space, mirrored to Paperless", async () => {
    const { h, paperless, admin, spaceOf, assign } = await setup();

    const response = await assign(300).expect(200);

    expect(response.body).toEqual({
      document_id: 300,
      space_id: spaceOf(admin.id),
      source: "default",
      paperless: "updated",
    });
    const [adminRow] = await h.db.select().from(members).where(eq(members.id, admin.id));
    expect(paperless.permissions.get(300)?.owner).toBe(adminRow!.paperlessUserId);
    expect(paperless.visibleTo(adminRow!.paperlessUserId!)).toEqual([300]);
  });

  it("uploads go to the uploading member's personal space", async () => {
    const { h, paperless, partner, spaceOf, assign } = await setup([
      { task_id: "t-other", status: "SUCCESS", related_document: "301" },
      { task_id: "t-mine", status: "SUCCESS", related_document: "302" },
    ]);
    await h.db.insert(uploadTaskMembers).values([
      { taskId: "t-other", memberId: partner.id },
      { taskId: "t-mine", memberId: partner.id },
    ]);

    const response = await assign(302).expect(200);

    expect(response.body).toMatchObject({ space_id: spaceOf(partner.id), source: "upload" });
    // Both finished tasks are remembered, so the next document needs no Paperless lookup.
    const rows = await h.db.select().from(uploadTaskMembers);
    expect(Object.fromEntries(rows.map((r) => [r.taskId, r.paperlessDocId]))).toEqual({
      "t-other": 301,
      "t-mine": 302,
    });
    paperless.taskLookups.length = 0;
    await assign(301).expect(200);
    expect(paperless.taskLookups).toEqual([]);
  });

  it("a duplicate / failed upload is remembered as producing no document", async () => {
    const { h, admin, partner, spaceOf, assign } = await setup([
      { task_id: "t-dup", status: "FAILURE", result: "Not consuming x: It is a duplicate of y (#12)." },
    ]);
    await h.db.insert(uploadTaskMembers).values({ taskId: "t-dup", memberId: partner.id });

    const response = await assign(300).expect(200);

    expect(response.body).toMatchObject({ space_id: spaceOf(admin.id), source: "default" });
    const [row] = await h.db.select().from(uploadTaskMembers);
    expect(row!.paperlessDocId).toBe(NO_DOCUMENT);
  });

  it("refuses (409) while a recent upload is still running, then assigns once it finished", async () => {
    const tasks: Record<string, unknown>[] = [{ task_id: "t-run", status: "STARTED", related_document: null }];
    const { h, partner, spaceOf, assign } = await setup(tasks);
    await h.db.insert(uploadTaskMembers).values({ taskId: "t-run", memberId: partner.id });

    await assign(300).expect(409);
    expect(await h.db.select().from(documentSpaces)).toEqual([]);

    tasks[0] = { task_id: "t-run", status: "SUCCESS", related_document: 300 };
    const response = await assign(300).expect(200);
    expect(response.body).toMatchObject({ space_id: spaceOf(partner.id), source: "upload" });
  });

  it("does not wait on an upload task older than an hour", async () => {
    const { h, admin, partner, spaceOf, assign } = await setup([{ task_id: "t-old", status: "STARTED" }]);
    await h.db.insert(uploadTaskMembers).values({ taskId: "t-old", memberId: partner.id });
    await h.db.execute(sql`UPDATE upload_task_members SET created_at = now() - interval '2 hours'`);

    const response = await assign(300).expect(200);
    expect(response.body).toMatchObject({ space_id: spaceOf(admin.id), source: "default" });
  });

  it("reprocess keeps the home space and writes nothing new to Paperless", async () => {
    const { h, paperless, partner, spaceOf, assign } = await setup();
    await h.db.insert(documentSpaces).values({ paperlessDocId: 300, spaceId: spaceOf(partner.id) });

    const first = await assign(300).expect(200);
    expect(first.body).toMatchObject({ space_id: spaceOf(partner.id), source: "existing", paperless: "updated" });
    const writes = paperless.tenancyWrites.length;

    const second = await assign(300).expect(200);
    expect(second.body).toMatchObject({
      space_id: spaceOf(partner.id),
      source: "existing",
      paperless: "unchanged",
    });
    expect(paperless.tenancyWrites).toHaveLength(writes);
  });

  it("a Paperless rejection of the permissions is a 502, and the home space stays recorded", async () => {
    const { h, paperless, assign } = await setup();
    paperless.setDocumentPermissions = async () => {
      throw new PaperlessRequestError(400, "nope", "http://paperless/api/documents/300/");
    };

    await assign(300).expect(502);
    expect(await h.db.select().from(documentSpaces)).toHaveLength(1);
  });
});

describe("upload records the uploading member", () => {
  it("writes upload_task_members with the caller's member id", async () => {
    const { h, admin } = await setup();
    const agent = request.agent(h.app.getHttpServer());
    await agent.post("/api/auth/login").send({ username: "admin", password: "correct-horse" }).expect(200);

    await agent
      .post("/api/documents/upload")
      .attach("files", Buffer.from("%PDF-1.4 x"), { filename: "a.pdf", contentType: "application/pdf" })
      .expect(200);

    expect(await h.db.select().from(uploadTaskMembers)).toEqual([
      expect.objectContaining({ taskId: "task-uuid-1234", memberId: admin.id, paperlessDocId: null }),
    ]);
  });
});
