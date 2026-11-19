import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { hashPassword } from "../auth/passwords.js";
import { documentSpaces, memberPaperlessTokens, members, spaces, users } from "../db/schema.js";
import { EventsService } from "../events/events.service.js";
import type { PaperlessGateway } from "../paperless/paperless.gateway.js";
import { MemberGateways } from "../tenancy/member-gateways.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { FakeGateway, TAGS, makeDoc } from "./fake-gateway.js";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

const PENDING = TAGS["ai-pending"] as number;
const PROPAGATED = TAGS["ai-propagated"] as number;

/**
 * Alice (household admin) owns docs 1 + 2 (2 pending), Bob (member) owns doc 3
 * (pending) and has trashed doc 4. Paperless permissions and home spaces match.
 */
async function household() {
  const paperless = new FakeGateway({
    docs: [
      makeDoc({ id: 1, tags: [PROPAGATED] }),
      makeDoc({ id: 2, tags: [PENDING] }),
      makeDoc({ id: 3, tags: [PENDING] }),
    ],
    trashed: [makeDoc({ id: 4 })],
  });
  harness = await createHarness({ gateway: paperless as unknown as Partial<PaperlessGateway> });
  const h = harness;
  await h.db.insert(users).values([
    { username: "alice", passwordHash: await hashPassword("alice-password") },
    { username: "bob", passwordHash: await hashPassword("bob-password") },
  ]);
  await h.app.get(TenancyService).reconcile();
  const all = await h.db.select().from(members);
  const alice = all.find((m) => m.role === "admin")!;
  const bob = all.find((m) => m.role === "member")!;
  // Provision both Paperless users + tokens the way a first request would.
  const gateways = h.app.get(MemberGateways);
  await gateways.forMember(alice.id);
  await gateways.forMember(bob.id);
  const linked = await h.db.select().from(members);
  const paperlessUser = (memberId: number) => linked.find((m) => m.id === memberId)!.paperlessUserId!;
  const allSpaces = await h.db.select().from(spaces);
  const spaceOf = (memberId: number) => allSpaces.find((s) => s.personalMemberId === memberId)!;
  const own = (docId: number, memberId: number) => {
    const space = spaceOf(memberId);
    paperless.permissions.set(docId, {
      owner: paperlessUser(memberId),
      permissions: {
        view: { users: [], groups: [space.paperlessGroupId!] },
        change: { users: [], groups: [space.paperlessGroupId!] },
      },
    });
    return { paperlessDocId: docId, spaceId: space.id };
  };
  await h.db.insert(documentSpaces).values([own(1, alice.id), own(2, alice.id), own(3, bob.id), own(4, bob.id)]);

  const login = async (username: string, password: string) => {
    const agent = request.agent(h.app.getHttpServer());
    await agent.post("/api/auth/login").send({ username, password }).expect(200);
    return agent;
  };
  return {
    h,
    paperless,
    alice,
    bob,
    paperlessUser,
    asAlice: await login("alice", "alice-password"),
    asBob: await login("bob", "bob-password"),
  };
}

const ids = (body: { results: { id: number }[] }) => body.results.map((r) => r.id).sort((a, b) => a - b);

// Two bcrypt hashes + two logins per test: slow under a parallel suite run.
describe("member isolation", { timeout: 30_000 }, () => {
  it("library lists, counts and facets only the member's documents", async () => {
    const { asAlice, asBob } = await household();

    const bobLib = (await asBob.get("/api/library/").expect(200)).body;
    expect(ids(bobLib)).toEqual([]); // doc 3 is pending → not in the library
    const aliceLib = (await asAlice.get("/api/library/").expect(200)).body;
    expect(ids(aliceLib)).toEqual([1]);

    const bobTypes = (await asBob.get("/api/library/types").expect(200)).body;
    const total = (rows: { count: number }[]) => rows.reduce((n, r) => n + r.count, 0);
    expect(total(bobTypes.results ?? bobTypes)).toBe(1);
  });

  it("review inbox shows only the member's pending documents", async () => {
    const { asAlice, asBob } = await household();
    expect(ids((await asBob.get("/api/inbox/?page=1&page_size=20").expect(200)).body)).toEqual([3]);
    expect(ids((await asAlice.get("/api/inbox/?page=1&page_size=20").expect(200)).body)).toEqual([2]);
  });

  it("another member's document is 404 for every read and write", async () => {
    const { asBob, paperless } = await household();
    const before = structuredClone([...paperless.docs.values()]);

    await asBob.get("/api/documents/1/detail").expect(404);
    await asBob.get("/api/inbox/2").expect(404);
    await asBob.get("/api/documents/1/preview").expect(404);
    await asBob.get("/api/documents/1/download").expect(404);
    await asBob.get("/api/documents/1/status").expect(404);
    await asBob.get("/api/documents/1/duplicate-candidates").expect(404);
    await asBob.patch("/api/documents/1/fields").send({ ai_title: "x" }).expect(404);
    await asBob.post("/api/inbox/2/approve").send({}).expect(404);
    await asBob.post("/api/inbox/2/reject").expect(404);
    await asBob.post("/api/documents/1/star").expect(404);
    await asBob.post("/api/documents/1/reprocess").expect(404);
    await asBob.delete("/api/documents/1").expect(404);

    expect([...paperless.docs.values()]).toEqual(before);
  });

  it("the member's own document works end to end", async () => {
    const { asBob, paperless } = await household();
    expect((await asBob.get("/api/documents/3/detail").expect(200)).body.id).toBe(3);
    await asBob.post("/api/documents/3/star").expect(200);
    expect(paperless.docs.get(3)?.tags).toContain(TAGS.wichtig);
  });

  it("trash lists only the member's own trashed documents", async () => {
    const { asAlice, asBob } = await household();
    expect(ids((await asBob.get("/api/trash/").expect(200)).body)).toEqual([4]);
    expect(ids((await asAlice.get("/api/trash/").expect(200)).body)).toEqual([]);
  });

  it("live counts are per member", async () => {
    const { h, alice, bob } = await household();
    const events = h.app.get(EventsService);
    const principalOf = async (memberId: number, role: "admin" | "member") => ({
      kind: "member" as const,
      memberId,
      userId: memberId,
      householdId: 1,
      username: "x",
      householdRole: role,
      scopes: new Set<never>(),
      sessionId: null,
      authTime: null,
      clientId: "spa" as const,
    });
    expect((await events.computeCounts(await principalOf(bob.id, "member"))).inbox).toBe(1);
    expect((await events.computeCounts(await principalOf(bob.id, "member"))).trash).toBe(1);
    expect((await events.computeCounts(await principalOf(alice.id, "admin"))).trash).toBe(0);
  });

  it("uploads go to Paperless as the uploading member", async () => {
    const { asBob, paperless, bob, paperlessUser } = await household();
    await asBob
      .post("/api/documents/upload")
      .attach("files", Buffer.from("%PDF-1.4 bob"), { filename: "b.pdf", contentType: "application/pdf" })
      .expect(200);
    expect(paperless.uploads.at(-1)?.owner).toBe(paperlessUser(bob.id));
  });

  it("import activity: a member sees their uploads only, the admin sees household imports", async () => {
    const { asAlice, asBob, paperless, bob, paperlessUser } = await household();
    const now = new Date().toISOString();
    paperless.tasks.push(
      { task_id: "t-mail", task_file_name: "mail.pdf", date_created: now, status: "SUCCESS", related_document: "1", owner: 3 },
      { task_id: "t-bob", task_file_name: "bob.pdf", date_created: now, status: "SUCCESS", related_document: "3", owner: paperlessUser(bob.id) },
    );
    const taskIds = (body: { items: { task_id: string }[] }) => body.items.map((i) => i.task_id).sort();
    expect(taskIds((await asBob.get("/api/ingest/activity?days=7").expect(200)).body)).toEqual(["t-bob"]);
    expect(taskIds((await asAlice.get("/api/ingest/activity?days=7").expect(200)).body)).toEqual(["t-bob", "t-mail"]);
  });

  it("re-mints a rejected member token once and the request still succeeds", async () => {
    const { h, asBob, paperless, bob, paperlessUser } = await household();
    const mintsBefore = paperless.mints.length;
    paperless.rejectOnce.add(`tok-${paperlessUser(bob.id)}`);

    expect((await asBob.get("/api/documents/3/detail").expect(200)).body.id).toBe(3);
    expect(paperless.mints.length).toBe(mintsBefore + 1);
    const [row] = await h.db.select().from(memberPaperlessTokens).where(eq(memberPaperlessTokens.memberId, bob.id));
    expect(row?.ciphertext).not.toContain("tok-");
  });

  it("re-mints when the stored token can't be decrypted (key changed)", async () => {
    const { h, asBob, paperless, bob } = await household();
    await h.db.update(memberPaperlessTokens).set({ keyId: "0000000000000000" }).where(eq(memberPaperlessTokens.memberId, bob.id));
    h.app.get(MemberGateways).forget(bob.id);
    const mintsBefore = paperless.mints.length;

    await asBob.get("/api/documents/3/detail").expect(200);
    expect(paperless.mints.length).toBe(mintsBefore + 1);
  });
});
