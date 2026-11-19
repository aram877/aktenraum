import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { documentSpaces, members, spaces, users } from "../db/schema.js";
import type { PaperlessDocument, PaperlessGateway } from "../paperless/paperless.gateway.js";
import { FakeGateway, TAGS, makeDoc } from "../test/fake-gateway.js";
import { createHarness, type Harness } from "../test/harness.js";
import { TenancyService } from "./tenancy.service.js";

const SECRET = "s3cret-for-tests";

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

/** Two propagated documents that match on every duplicate key. */
function twin(id: number): PaperlessDocument {
  return makeDoc({
    id,
    tags: [TAGS["ai-propagated"] as number],
    custom_fields: [
      { field: 10, value: "Stadtwerke München" },
      { field: 11, value: "Rechnung" },
      { field: 13, value: "2026-03-15" },
      { field: 17, value: "RE-4711" },
    ],
  });
}

async function setup(docs: PaperlessDocument[]) {
  const paperless = new FakeGateway({ docs });
  harness = await createHarness({
    gateway: paperless as unknown as Partial<PaperlessGateway>,
    env: { WEBHOOK_SECRET: SECRET, BOOTSTRAP_USERNAME: "admin", BOOTSTRAP_PASSWORD: "correct-horse" },
  });
  await harness.db.insert(users).values({ username: "partner", passwordHash: "x" });
  await harness.app.get(TenancyService).reconcile();
  const all = await harness.db.select().from(members);
  const admin = all.find((m) => m.role === "admin")!;
  const partner = all.find((m) => m.role === "member")!;
  const allSpaces = await harness.db.select().from(spaces);
  const spaceOf = (memberId: number) => allSpaces.find((s) => s.personalMemberId === memberId)!.id;
  const agent = request.agent(harness.app.getHttpServer());
  await agent.post("/api/auth/login").send({ username: "admin", password: "correct-horse" }).expect(200);
  return { h: harness, admin, partner, spaceOf, agent };
}

describe("GET /api/tenancy/documents/:doc_id/space (worker)", () => {
  it("returns the home space and its documents", async () => {
    const { h, admin, partner, spaceOf } = await setup([makeDoc({ id: 1 })]);
    await h.db.insert(documentSpaces).values([
      { paperlessDocId: 1, spaceId: spaceOf(admin.id) },
      { paperlessDocId: 2, spaceId: spaceOf(admin.id) },
      { paperlessDocId: 3, spaceId: spaceOf(partner.id) },
    ]);

    const response = await request(h.app.getHttpServer())
      .get("/api/tenancy/documents/1/space")
      .set("X-Aktenraum-Secret", SECRET)
      .expect(200);

    expect(response.body).toEqual({
      document_id: 1,
      space_id: spaceOf(admin.id),
      shared_with: [],
      space_document_ids: [1, 2],
    });
  });

  it("answers null for a document without a home space", async () => {
    const { h } = await setup([makeDoc({ id: 1 })]);
    const response = await request(h.app.getHttpServer())
      .get("/api/tenancy/documents/1/space")
      .set("X-Aktenraum-Secret", SECRET)
      .expect(200);
    expect(response.body).toMatchObject({ space_id: null, space_document_ids: [] });
  });

  it("is not reachable with a session", async () => {
    const { agent } = await setup([makeDoc({ id: 1 })]);
    await agent.get("/api/tenancy/documents/1/space").expect(401);
  });
});

describe("duplicate candidates stay inside the home space", () => {
  it("flags a twin in the same space, not one in another space", async () => {
    const { h, admin, partner, spaceOf, agent } = await setup([twin(10), twin(11), twin(12)]);
    await h.db.insert(documentSpaces).values([
      { paperlessDocId: 10, spaceId: spaceOf(admin.id) },
      { paperlessDocId: 11, spaceId: spaceOf(admin.id) },
      { paperlessDocId: 12, spaceId: spaceOf(partner.id) },
    ]);

    const response = await agent.get("/api/documents/10/duplicate-candidates").expect(200);
    const ids = (response.body.candidates as { id: number }[]).map((c) => c.id);
    expect(ids).toEqual([11]);
  });

  it("compares unassigned documents only with each other", async () => {
    const { h, admin, spaceOf, agent } = await setup([twin(10), twin(11), twin(12)]);
    await h.db.insert(documentSpaces).values({ paperlessDocId: 12, spaceId: spaceOf(admin.id) });

    const response = await agent.get("/api/documents/10/duplicate-candidates").expect(200);
    const ids = (response.body.candidates as { id: number }[]).map((c) => c.id);
    expect(ids).toEqual([11]);
  });
});

describe("detail responses show the home space", () => {
  it("personal space with its owner's username, on both detail endpoints", async () => {
    const { h, admin, spaceOf, agent } = await setup([makeDoc({ id: 42 })]);
    await h.db.insert(documentSpaces).values({ paperlessDocId: 42, spaceId: spaceOf(admin.id) });

    const expected = { id: spaceOf(admin.id), name: "Persönlich", kind: "personal", owner: "admin" };
    expect((await agent.get("/api/documents/42/detail").expect(200)).body.home_space).toEqual(expected);
    expect((await agent.get("/api/inbox/42").expect(200)).body.home_space).toEqual(expected);
  });

  it("null for a document without a home space", async () => {
    const { agent } = await setup([makeDoc({ id: 42 })]);
    expect((await agent.get("/api/documents/42/detail").expect(200)).body.home_space).toBeNull();
  });

  it("a shared space shows its first owner", async () => {
    const { h, admin, partner, agent } = await setup([makeDoc({ id: 42 })]);
    const [household] = await h.db.select().from((await import("../db/schema.js")).households);
    const [shared] = await h.db
      .insert(spaces)
      .values({ householdId: household!.id, name: "Haushalt", kind: "shared" })
      .returning();
    const { spaceMembers } = await import("../db/schema.js");
    await h.db.insert(spaceMembers).values([
      { spaceId: shared!.id, memberId: partner.id, role: "owner" },
      { spaceId: shared!.id, memberId: admin.id, role: "owner" },
    ]);
    await h.db.insert(documentSpaces).values({ paperlessDocId: 42, spaceId: shared!.id });

    const body = (await agent.get("/api/documents/42/detail").expect(200)).body;
    expect(body.home_space).toEqual({
      id: shared!.id,
      name: "Haushalt",
      kind: "shared",
      owner: admin.id < partner.id ? "admin" : "partner",
    });
  });
});
