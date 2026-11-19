import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hashPassword } from "../auth/passwords.js";
import { documentSpaces, members, spaces, users } from "../db/schema.js";
import { EventsService } from "../events/events.service.js";
import type { PaperlessGateway } from "../paperless/paperless.gateway.js";
import { FakeGateway, TAGS, makeDoc } from "../test/fake-gateway.js";
import { createHarness, type Harness } from "../test/harness.js";
import { MemberGateways } from "../tenancy/member-gateways.js";
import { TenancyService } from "../tenancy/tenancy.service.js";

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

const PROPAGATED = TAGS["ai-propagated"] as number;

/**
 * Alice (household admin), Bob and Carol (members). Personal documents:
 * Alice 1 + 3, Bob 2, Carol 5. Paperless permissions match the home spaces.
 */
async function household() {
  const paperless = new FakeGateway({
    docs: [1, 2, 3, 5].map((id) => makeDoc({ id, tags: [PROPAGATED] })),
  });
  const vectorStore = {
    setSpaceByDocId: vi.fn(async (_docId: number, _space: unknown) => undefined),
    deleteByDocId: vi.fn(async () => undefined),
  };
  harness = await createHarness({ gateway: paperless as unknown as Partial<PaperlessGateway>, vectorStore });
  const h = harness;
  const password = await hashPassword("password-123");
  await h.db.insert(users).values([
    { username: "alice", passwordHash: password },
    { username: "bob", passwordHash: password },
    { username: "carol", passwordHash: password },
  ]);
  await h.app.get(TenancyService).reconcile();
  const all = await h.db.select().from(members);
  const byName = async (name: string) => {
    const [u] = await h.db.select().from(users).where(eq(users.username, name));
    return all.find((m) => m.userId === u!.id)!;
  };
  const alice = await byName("alice");
  const bob = await byName("bob");
  const carol = await byName("carol");
  const gateways = h.app.get(MemberGateways);
  for (const m of [alice, bob, carol]) await gateways.forMember(m.id);
  const paperlessUser = async (memberId: number) =>
    (await h.db.select().from(members).where(eq(members.id, memberId)))[0]!.paperlessUserId!;
  const personal = async (memberId: number) =>
    (await h.db.select().from(spaces).where(eq(spaces.personalMemberId, memberId)))[0]!;
  const own = async (docId: number, memberId: number) => {
    const space = await personal(memberId);
    paperless.permissions.set(docId, {
      owner: await paperlessUser(memberId),
      permissions: {
        view: { users: [], groups: [space.paperlessGroupId!] },
        change: { users: [], groups: [space.paperlessGroupId!] },
      },
    });
    await h.db.insert(documentSpaces).values({ paperlessDocId: docId, spaceId: space.id });
  };
  await own(1, alice.id);
  await own(3, alice.id);
  await own(2, bob.id);
  await own(5, carol.id);

  const login = async (username: string) => {
    const agent = request.agent(h.app.getHttpServer());
    await agent.post("/api/auth/login").send({ username, password: "password-123" }).expect(200);
    return agent;
  };
  return {
    h,
    paperless,
    vectorStore,
    alice,
    bob,
    carol,
    paperlessUser,
    personal,
    asAlice: await login("alice"),
    asBob: await login("bob"),
    asCarol: await login("carol"),
  };
}

type Agent = Awaited<ReturnType<typeof household>>["asAlice"];

async function createSpace(agent: Agent, name = "Haushalt"): Promise<number> {
  return (await agent.post("/api/spaces").send({ name }).expect(201)).body.id as number;
}

const homeOf = async (h: Harness, docId: number) =>
  (await h.db.select().from(documentSpaces).where(eq(documentSpaces.paperlessDocId, docId)))[0]?.spaceId;

const libraryIds = async (agent: Agent) =>
  ((await agent.get("/api/library/").expect(200)).body.results as { id: number }[]).map((r) => r.id).sort((a, b) => a - b);

describe("spaces API", { timeout: 60_000 }, () => {
  it("create, list, duplicate name, rename, delete", async () => {
    const { asAlice, asBob } = await household();

    const created = (await asAlice.post("/api/spaces").send({ name: "  Haushalt " }).expect(201)).body;
    expect(created).toMatchObject({ name: "Haushalt", kind: "shared", role: "owner", owner: "alice", member_count: 1, document_count: 0 });

    const list = (await asAlice.get("/api/spaces").expect(200)).body;
    expect(list.household_member_count).toBe(3);
    expect(list.spaces.map((s: { kind: string; name: string }) => `${s.kind}:${s.name}`)).toEqual([
      "personal:Persönlich",
      "shared:Haushalt",
    ]);
    expect((await asBob.get("/api/spaces").expect(200)).body.spaces).toHaveLength(1);

    await asAlice.post("/api/spaces").send({ name: "Haushalt" }).expect(409);
    await asBob.post("/api/spaces").send({ name: "Haushalt" }).expect(201); // Bob isn't in Alice's
    await asAlice.post("/api/spaces").send({ name: "" }).expect(422);

    await asAlice.patch(`/api/spaces/${created.id}`).send({ name: "Haus" }).expect(204);
    await asBob.patch(`/api/spaces/${created.id}`).send({ name: "X" }).expect(404); // outsider
    await asBob.delete(`/api/spaces/${created.id}`).expect(404);

    await asAlice.delete(`/api/spaces/${created.id}`).expect(204);
    expect((await asAlice.get("/api/spaces").expect(200)).body.spaces).toHaveLength(1);
  });

  it("personal spaces refuse rename, delete and membership edits", async () => {
    const { asAlice, alice, bob, personal } = await household();
    const mine = (await personal(alice.id)).id;
    await asAlice.patch(`/api/spaces/${mine}`).send({ name: "X" }).expect(409);
    await asAlice.delete(`/api/spaces/${mine}`).expect(409);
    await asAlice.post(`/api/spaces/${mine}/members`).send({ member_id: bob.id, role: "viewer" }).expect(409);
    // Someone else's personal space doesn't exist for me.
    await asAlice.get(`/api/spaces/${(await personal(bob.id)).id}/members`).expect(404);
  });

  it("deleting a space that still holds a document — trashed counts — is refused", async () => {
    const { h, asAlice } = await household();
    const id = await createSpace(asAlice);
    await asAlice.post("/api/documents/1/move").send({ space_id: id }).expect(200);
    await asAlice.delete(`/api/spaces/${id}`).expect(409);

    await asAlice.delete("/api/documents/1").expect(204); // → trash, row kept
    await asAlice.delete(`/api/spaces/${id}`).expect(409);
    await asAlice.post("/api/trash/1/delete").expect(204); // hard delete drops the row
    expect(await homeOf(h, 1)).toBeUndefined();
    await asAlice.delete(`/api/spaces/${id}`).expect(204);
  });

  it("membership matrix: owner manages, editor and viewer can't, outsider sees nothing", async () => {
    const { asAlice, asBob, asCarol, bob, carol, alice } = await household();
    const id = await createSpace(asAlice);

    expect((await asAlice.post(`/api/spaces/${id}/members`).send({ member_id: bob.id, role: "editor" }).expect(201)).body)
      .toEqual({ member_id: bob.id, username: "bob", role: "editor" });
    await asAlice.post(`/api/spaces/${id}/members`).send({ member_id: bob.id, role: "viewer" }).expect(409);
    await asAlice.post(`/api/spaces/${id}/members`).send({ member_id: 9999, role: "viewer" }).expect(404);
    await asAlice.post(`/api/spaces/${id}/members`).send({ member_id: carol.id, role: "owner" }).expect(422);

    await asCarol.get(`/api/spaces/${id}/members`).expect(404);
    await asBob.post(`/api/spaces/${id}/members`).send({ member_id: carol.id, role: "viewer" }).expect(403);
    await asAlice.post(`/api/spaces/${id}/members`).send({ member_id: carol.id, role: "viewer" }).expect(201);
    await asCarol.patch(`/api/spaces/${id}/members/${bob.id}`).send({ role: "viewer" }).expect(403);
    await asBob.delete(`/api/spaces/${id}/members/${carol.id}`).expect(403);
    await asCarol.delete(`/api/spaces/${id}/members/${alice.id}`).expect(403);

    const listed = (await asCarol.get(`/api/spaces/${id}/members`).expect(200)).body;
    expect(listed.map((m: { username: string; role: string }) => `${m.username}:${m.role}`)).toEqual([
      "alice:owner",
      "bob:editor",
      "carol:viewer",
    ]);
    const bobSpaces = (await asBob.get("/api/spaces").expect(200)).body.spaces;
    expect(bobSpaces.find((s: { id: number }) => s.id === id)).toMatchObject({ role: "editor", owner: "alice", member_count: 3 });

    // The owner is immutable.
    await asAlice.patch(`/api/spaces/${id}/members/${alice.id}`).send({ role: "viewer" }).expect(409);
    await asAlice.delete(`/api/spaces/${id}/members/${alice.id}`).expect(409);
    await asAlice.patch(`/api/spaces/${id}/members/${bob.id}`).send({ role: "viewer" }).expect(200);
    await asAlice.delete(`/api/spaces/${id}/members/${bob.id}`).expect(204);
    await asAlice.delete(`/api/spaces/${id}/members/${bob.id}`).expect(404);
  });

  it("roles decide document actions; Paperless groups follow role changes", async () => {
    const { h, paperless, asAlice, asBob, asCarol, bob, carol, paperlessUser } = await household();
    const id = await createSpace(asAlice);
    await asAlice.post(`/api/spaces/${id}/members`).send({ member_id: bob.id, role: "editor" }).expect(201);
    await asAlice.post(`/api/spaces/${id}/members`).send({ member_id: carol.id, role: "viewer" }).expect(201);
    await asAlice.post("/api/documents/1/move").send({ space_id: id }).expect(200);

    await asCarol.get("/api/documents/1/detail").expect(200);
    await asCarol.get("/api/documents/1/download").expect(200);
    await asCarol.patch("/api/documents/1/fields").send({ ai_title: "x" }).expect(404);
    await asBob.patch("/api/documents/1/fields").send({ ai_title: "von Bob" }).expect(200);
    await asBob.delete("/api/documents/1").expect(404);
    expect(await libraryIds(asCarol)).toEqual([1, 5]);

    const [space] = await h.db.select().from(spaces).where(eq(spaces.id, id));
    const writer = space!.paperlessGroupId!;
    expect(paperless.users.get(await paperlessUser(bob.id))!.groups).toContain(writer);
    await asAlice.patch(`/api/spaces/${id}/members/${bob.id}`).send({ role: "viewer" }).expect(200);
    const bobUser = await paperlessUser(bob.id);
    expect(paperless.users.get(bobUser)!.groups).not.toContain(writer);
    expect(paperless.canChange(bobUser, 1)).toBe(false);
    expect(paperless.visibleTo(bobUser)).toContain(1);
    await asBob.patch("/api/documents/1/fields").send({ ai_title: "x" }).expect(404);
  });

  it("leaving takes effect at once for library, detail, counts and RAG access", async () => {
    const { h, asAlice, asBob, bob } = await household();
    const id = await createSpace(asAlice);
    await asAlice.post(`/api/spaces/${id}/members`).send({ member_id: bob.id, role: "editor" }).expect(201);
    await asAlice.post("/api/documents/1/move").send({ space_id: id }).expect(200);
    const tenancy = h.app.get(TenancyService);
    expect(await libraryIds(asBob)).toEqual([1, 2]);
    expect((await tenancy.searchAccess({ memberId: bob.id, householdRole: "member" })).spaceIds).toContain(id);

    await asBob.delete(`/api/spaces/${id}/members/${bob.id}`).expect(204);

    expect(await libraryIds(asBob)).toEqual([2]);
    await asBob.get("/api/documents/1/detail").expect(404);
    expect((await tenancy.searchAccess({ memberId: bob.id, householdRole: "member" })).spaceIds).not.toContain(id);
    const counts = await h.app.get(EventsService).computeCounts({
      kind: "member",
      memberId: bob.id,
      userId: bob.userId,
      householdId: 1,
      username: "bob",
      householdRole: "member",
      scopes: new Set(),
      sessionId: null,
      authTime: null,
      clientId: "spa",
    });
    expect(counts.errors).toBe(0);
    expect((await asBob.get("/api/spaces").expect(200)).body.spaces).toHaveLength(1);
  });

  it("directory: every member sees ids and usernames, nothing else", async () => {
    const { asCarol, alice, bob, carol } = await household();
    expect((await asCarol.get("/api/household/directory").expect(200)).body).toEqual([
      { id: alice.id, username: "alice" },
      { id: bob.id, username: "bob" },
      { id: carol.id, username: "carol" },
    ]);
    await asCarol.get("/api/household/members").expect(403);
  });
});

describe("moving documents", { timeout: 60_000 }, () => {
  it("moves into a shared space: home space, Paperless owner + groups, Qdrant space", async () => {
    const { h, paperless, vectorStore, asAlice, asBob, bob, alice, paperlessUser } = await household();
    const id = await createSpace(asAlice);
    await asAlice.post(`/api/spaces/${id}/members`).send({ member_id: bob.id, role: "editor" }).expect(201);
    // Bob (editor) moves his own personal document in: owner of source, editor of target.
    expect((await asBob.post("/api/documents/2/move").send({ space_id: id }).expect(200)).body).toEqual({ doc_id: 2, status: "moved" });

    expect(await homeOf(h, 2)).toBe(id);
    expect(paperless.permissions.get(2)!.owner).toBe(await paperlessUser(alice.id)); // the space owner
    expect(vectorStore.setSpaceByDocId).toHaveBeenLastCalledWith(2, { spaceId: id, sharedWith: [] });
    expect(await libraryIds(asAlice)).toEqual([1, 2, 3]);

    // Moving out needs owner of the current space: Bob is only an editor now.
    const mine = (await asBob.get("/api/spaces").expect(200)).body.spaces.find((s: { kind: string }) => s.kind === "personal").id;
    await asBob.post("/api/documents/2/move").send({ space_id: mine }).expect(403);
    expect(await homeOf(h, 2)).toBe(id);
    // Same space = no-op.
    expect((await asAlice.post("/api/documents/2/move").send({ space_id: id }).expect(200)).body.status).toBe("unchanged");
  });

  it("refuses targets the caller can't place into, and hides documents they can't read", async () => {
    const { h, asAlice, asCarol, carol, personal, alice } = await household();
    const id = await createSpace(asAlice);
    await asAlice.post(`/api/spaces/${id}/members`).send({ member_id: carol.id, role: "viewer" }).expect(201);
    await asCarol.post("/api/documents/5/move").send({ space_id: id }).expect(403); // viewer of target
    await asCarol.post("/api/documents/1/move").send({ space_id: id }).expect(404); // can't read doc 1
    await asAlice.post("/api/documents/1/move").send({ space_id: (await personal(carol.id)).id }).expect(404); // not my space
    await asAlice.post("/api/documents/424242/move").send({ space_id: id }).expect(404);
    expect(await homeOf(h, 1)).toBe((await personal(alice.id)).id);
    expect(await homeOf(h, 5)).toBe((await personal(carol.id)).id);
  });

  it("Paperless failure undoes the move with 502", async () => {
    const { h, paperless, vectorStore, asAlice, alice, personal } = await household();
    const id = await createSpace(asAlice);
    const before = structuredClone(paperless.permissions.get(1));
    const original = paperless.setDocumentPermissions;
    let calls = 0;
    paperless.setDocumentPermissions = async (docId, target) => {
      calls += 1;
      if (calls === 1) throw new Error("paperless down");
      return original(docId, target);
    };

    await asAlice.post("/api/documents/1/move").send({ space_id: id }).expect(502);

    expect(await homeOf(h, 1)).toBe((await personal(alice.id)).id);
    expect(paperless.permissions.get(1)).toEqual(before);
    expect(vectorStore.setSpaceByDocId).not.toHaveBeenCalled();
  });

  it("Qdrant failure undoes the move with 502, Paperless and chunks back to the source", async () => {
    const { h, paperless, vectorStore, asAlice, alice, personal } = await household();
    const id = await createSpace(asAlice);
    const source = (await personal(alice.id)).id;
    const before = structuredClone(paperless.permissions.get(1));
    vectorStore.setSpaceByDocId.mockImplementationOnce(async () => {
      throw new Error("qdrant down");
    });

    await asAlice.post("/api/documents/1/move").send({ space_id: id }).expect(502);

    expect(await homeOf(h, 1)).toBe(source);
    expect(paperless.permissions.get(1)).toEqual(before);
    expect(vectorStore.setSpaceByDocId).toHaveBeenLastCalledWith(1, { spaceId: source, sharedWith: [] });
  });

  it("bulk move reports per document and never leaks existence", async () => {
    const { h, asAlice, asBob, alice } = await household();
    const haushalt = await createSpace(asAlice);
    const bobs = await createSpace(asBob, "Bobs Akte");
    await asBob.post(`/api/spaces/${bobs}/members`).send({ member_id: alice.id, role: "editor" }).expect(201);
    await asBob.post("/api/documents/2/move").send({ space_id: bobs }).expect(200);

    const { results } = (
      await asAlice.post(`/api/spaces/${haushalt}/documents`).send({ doc_ids: [1, 3, 2, 5, 424242, 1] }).expect(200)
    ).body;

    expect(results.map((r: { doc_id: number; status: string }) => `${r.doc_id}:${r.status}`)).toEqual([
      "1:moved",
      "3:moved",
      "2:forbidden",
      "5:not_found", // Carol's — exists, but Alice can't read it
      "424242:not_found",
    ]);
    expect(await homeOf(h, 2)).toBe(bobs);
    await asAlice.post(`/api/spaces/${haushalt}/documents`).send({ doc_ids: [] }).expect(422);
    await asAlice
      .post(`/api/spaces/${haushalt}/documents`)
      .send({ doc_ids: Array.from({ length: 201 }, (_, i) => i + 1) })
      .expect(422);
  });
});
