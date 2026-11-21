import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { hashPassword } from "../auth/passwords.js";
import { documentSpaces, memberRemovals, members, spaceMembers, spaces, uploadTaskSpaces, users } from "../db/schema.js";
import type { PaperlessGateway } from "../paperless/paperless.gateway.js";
import { FakeGateway, makeDoc } from "../test/fake-gateway.js";
import { createHarness, type Harness } from "../test/harness.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { registerPasskey } from "../test/passkey-helpers.js";

const SECRET = "s3cret-for-tests";

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function setup() {
  const paperless = new FakeGateway({ docs: [makeDoc({ id: 300 })] });
  harness = await createHarness({
    gateway: paperless as unknown as Partial<PaperlessGateway>,
    env: { WEBHOOK_SECRET: SECRET },
  });
  const h = harness;
  const password = await hashPassword("password-123");
  await h.db.insert(users).values([
    { username: "alice", passwordHash: password },
    { username: "bob", passwordHash: password },
  ]);
  await h.app.get(TenancyService).reconcile();
  const all = await h.db.select().from(members);
  const alice = all.find((m) => m.role === "admin")!;
  const bob = all.find((m) => m.role === "member")!;
  const login = async (username: string) => {
    const agent = request.agent(h.app.getHttpServer());
    await agent.post("/api/auth/login").send({ username, password: "password-123" }).expect(200);
    await registerPasskey(agent);
    return agent;
  };
  const asAlice = await login("alice");
  const asBob = await login("bob");
  const shared = (await asAlice.post("/api/spaces").send({ name: "Haushalt" }).expect(201)).body.id as number;
  const personalOf = async (memberId: number) =>
    (await h.db.select().from(spaces).where(eq(spaces.personalMemberId, memberId)))[0]!.id;
  const upload = (agent: typeof asAlice, spaceId?: number | string) => {
    const req = agent.post("/api/documents/upload");
    if (spaceId !== undefined) req.field("space_id", String(spaceId));
    return req.attach("files", Buffer.from("%PDF-1.4 x"), { filename: "x.pdf", contentType: "application/pdf" });
  };
  /** Paperless finished the task with document 300; the worker asks for its home space. */
  const assign = async () => {
    paperless.tasks.push({ task_id: "task-uuid-1234", status: "SUCCESS", related_document: "300", owner: 0 });
    return request(h.app.getHttpServer())
      .post("/api/tenancy/assign-home-space")
      .set("X-Aktenraum-Secret", SECRET)
      .send({ document_id: 300 })
      .expect(200);
  };
  return { h, paperless, alice, bob, asAlice, asBob, shared, personalOf, upload, assign };
}

describe("upload into a space", { timeout: 30_000 }, () => {
  it("an editor's upload lands in the chosen shared space", async () => {
    const { h, asAlice, asBob, bob, shared, upload, assign } = await setup();
    await asAlice.post(`/api/spaces/${shared}/members`).send({ member_id: bob.id, role: "editor" }).expect(201);

    await upload(asBob, shared).expect(200);
    expect(await h.db.select().from(uploadTaskSpaces)).toMatchObject([{ taskId: "task-uuid-1234", spaceId: shared }]);

    expect((await assign()).body).toMatchObject({ space_id: shared, source: "upload" });
    const [row] = await h.db.select().from(documentSpaces).where(eq(documentSpaces.paperlessDocId, 300));
    expect(row!.spaceId).toBe(shared);
  });

  it("without a choice the upload lands in the personal space", async () => {
    const { asBob, bob, personalOf, upload, assign } = await setup();
    await upload(asBob).expect(200);
    expect((await assign()).body.space_id).toBe(await personalOf(bob.id));
  });

  it("a viewer or outsider is refused with 403 before anything reaches Paperless", async () => {
    const { paperless, asAlice, asBob, bob, shared, upload } = await setup();
    await upload(asBob, shared).expect(403); // not in the space
    await asAlice.post(`/api/spaces/${shared}/members`).send({ member_id: bob.id, role: "viewer" }).expect(201);
    await upload(asBob, shared).expect(403);
    await upload(asBob, "abc").expect(400);
    expect(paperless.uploads).toEqual([]);
  });

  it("falls back to the personal space when the uploader lost editor rights meanwhile", async () => {
    const { h, asAlice, asBob, bob, shared, personalOf, upload, assign } = await setup();
    await asAlice.post(`/api/spaces/${shared}/members`).send({ member_id: bob.id, role: "editor" }).expect(201);
    await upload(asBob, shared).expect(200);
    await h.db
      .update(spaceMembers)
      .set({ role: "viewer" })
      .where(and(eq(spaceMembers.spaceId, shared), eq(spaceMembers.memberId, bob.id)));

    expect((await assign()).body.space_id).toBe(await personalOf(bob.id));
  });

  it("an upload by a member removed meanwhile lands in the successor's personal space, whatever was picked", async () => {
    const { h, asAlice, asBob, alice, bob, shared, personalOf, upload, assign } = await setup();
    await asAlice.post(`/api/spaces/${shared}/members`).send({ member_id: bob.id, role: "editor" }).expect(201);
    await upload(asBob, shared).expect(200);
    await asAlice.post(`/api/household/members/${bob.id}/remove`).send({ confirm_username: "bob" }).expect(200);
    // Bob's upload_task_spaces row still points at a space he no longer belongs to.
    expect(await h.db.select().from(uploadTaskSpaces)).toMatchObject([{ spaceId: shared }]);

    expect((await assign()).body).toMatchObject({ space_id: await personalOf(alice.id), source: "upload" });
  });

  it("follows a chain of successors", async () => {
    const { h, asBob, alice, bob, personalOf, upload, assign } = await setup();
    await h.db.insert(users).values({ username: "carol", passwordHash: "x" });
    await h.app.get(TenancyService).reconcile();
    const carol = (await h.db.select().from(members)).find((m) => m.id !== alice.id && m.id !== bob.id)!;
    await upload(asBob).expect(200);
    // Bob → Carol, later Carol → Alice.
    await h.db.insert(memberRemovals).values([
      { memberId: bob.id, successorId: carol.id, removedBy: alice.id, phase: "done" },
      { memberId: carol.id, successorId: alice.id, removedBy: alice.id, phase: "done" },
    ]);
    expect((await assign()).body.space_id).toBe(await personalOf(alice.id));
  });
});
