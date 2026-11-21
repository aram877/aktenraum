import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { ModulesContainer } from "@nestjs/core";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { asc, eq } from "drizzle-orm";

import {
  authAudit,
  documentShares,
  documentSpaces,
  memberPaperlessTokens,
  memberRemovalDocuments,
  memberRemovals,
  members,
  sessions,
  shareAudit,
  spaceMembers,
  spaces,
} from "../db/schema.js";
import type { DocumentPermissions } from "../paperless/paperless.gateway.js";
import { TAGS, makeDoc } from "../test/fake-gateway.js";
import { createSpace, household } from "../test/household.js";
import { MemberRemovalService } from "./member-removal.service.js";
import { ORIGIN, passkeyLogin } from "../test/passkey-helpers.js";

type Fixture = Awaited<ReturnType<typeof household>>;

let fx: Fixture | null = null;

afterEach(async () => {
  await fx?.h.close();
  fx = null;
});

async function setup(): Promise<Fixture> {
  fx = await household();
  return fx;
}

/** Marks a member removed the way the removal's lockout step does (row only). */
async function markRemoved(f: Fixture, memberId: number, successorId = f.alice.id): Promise<void> {
  await f.h.db.insert(memberRemovals).values({ memberId, successorId, removedBy: f.alice.id });
}

const VERBS: Record<number, string> = { 0: "get", 1: "post", 2: "put", 3: "delete", 4: "patch" };

/** One guarded route per controller, with its path params filled in. */
function oneGuardedRoutePerController(f: Fixture): { verb: string; path: string }[] {
  const out: { verb: string; path: string }[] = [];
  for (const module of f.h.app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const ctrl = wrapper.metatype as { prototype: Record<string, unknown> } & object;
      const base = String(Reflect.getMetadata(PATH_METADATA, ctrl) ?? "").replace(/^\/|\/$/g, "");
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const handler = ctrl.prototype[name];
        if (typeof handler !== "function" || name === "constructor") continue;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        if (path === undefined) continue;
        const guards = [
          ...((Reflect.getMetadata(GUARDS_METADATA, ctrl) as unknown[]) ?? []),
          ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? []),
        ];
        if (guards.length === 0) continue;
        const verb = VERBS[Reflect.getMetadata(METHOD_METADATA, handler) as number] ?? "get";
        const full = ["", "api", base, String(path).replace(/^\/|\/$/g, "")]
          .filter(Boolean)
          .join("/")
          .replace(/:[a-z_]+/g, "2");
        out.push({ verb, path: `/${full}` });
        break;
      }
    }
  }
  return out;
}

describe("removed members: lockout", () => {
  it("rejects a removed member's open session with 401 on one route per controller", async () => {
    const f = await setup();
    await f.asBob.get("/api/auth/me").expect(200);
    await markRemoved(f, f.bob.id);
    const routes = oneGuardedRoutePerController(f);
    expect(routes.length).toBeGreaterThan(10);
    for (const route of routes) {
      const agent = f.asBob as unknown as Record<string, (path: string) => request.Test>;
      const response = await agent[route.verb]!(route.path).send({});
      expect({ route: `${route.verb} ${route.path}`, status: response.status }).toEqual({
        route: `${route.verb} ${route.path}`,
        status: 401,
      });
    }
    // Other members are unaffected.
    await f.asCarol.get("/api/auth/me").expect(200);
  });

  it("refuses a removed member's login exactly like a wrong password, and counts it", async () => {
    const f = await setup();
    await markRemoved(f, f.bob.id);
    const server = f.h.app.getHttpServer();
    // From another address, so only bob's attempts count against this one.
    const wrong = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "198.51.100.9")
      .send({ username: "carol", password: "nope-nope-1" });
    const removed = await request(server).post("/api/auth/login").send({ username: "bob", password: "password-123" });
    expect(removed.status).toBe(wrong.status);
    expect(removed.body).toEqual(wrong.body);
    expect(removed.headers["set-cookie"]).toBeUndefined();
    // Nine more correct-password attempts reach the throttle (10 failures).
    for (let i = 0; i < 9; i += 1) {
      await request(server).post("/api/auth/login").send({ username: "bob", password: "password-123" }).expect(401);
    }
    await request(server).post("/api/auth/login").send({ username: "bob", password: "password-123" }).expect(429);
  });

  it("keeps a removed member's username taken for invite redemption (409)", async () => {
    const f = await setup();
    await markRemoved(f, f.bob.id);
    const { token } = (await f.asAlice.post("/api/household/invites").expect(201)).body as { token: string };
    const response = await request(f.h.app.getHttpServer())
      .post(`/api/invites/${token}/register/begin`)
      .set("Origin", ORIGIN)
      .send({ username: "bob" });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ detail: "Benutzername bereits vergeben" });
  });
});

describe("removed members: kept as history, not as members", () => {
  it("drops them from the member list, the directory and the household member count", async () => {
    const f = await setup();
    const before = (await f.asCarol.get("/api/spaces").expect(200)).body as { household_member_count: number };
    expect(before.household_member_count).toBe(3);
    await markRemoved(f, f.bob.id);
    const list = (await f.asAlice.get("/api/household/members").expect(200)).body as { username: string }[];
    expect(list.map((m) => m.username)).toEqual(["alice", "carol"]);
    const directory = (await f.asCarol.get("/api/household/directory").expect(200)).body as { username: string }[];
    expect(directory.map((m) => m.username)).toEqual(["alice", "carol"]);
    const after = (await f.asCarol.get("/api/spaces").expect(200)).body as { household_member_count: number };
    expect(after.household_member_count).toBe(2);
  });

  it("refuses them as a space member (404) and as a share recipient (422)", async () => {
    const f = await setup();
    await markRemoved(f, f.bob.id);
    const spaceId = (await f.asCarol.post("/api/spaces").send({ name: "Wohnung" }).expect(201)).body.id as number;
    await f.asCarol.post(`/api/spaces/${spaceId}/members`).send({ member_id: f.bob.id, role: "editor" }).expect(404);
    await f.asCarol.post("/api/documents/5/shares").send({ member_id: f.bob.id, role: "viewer" }).expect(422);
  });
});

// ---------------------------------------------------------------- removal core

const PROPAGATED = TAGS["ai-propagated"] as number;

/**
 * Alice (admin), Bob, Carol. Bob: personal 2, 7 (trashed), 8, 9 (vanished
 * from Paperless); owns "Wohnung" (doc 6) with Carol editor + Alice viewer;
 * editor in Alice's "Haushalt" (doc 3). Shares: Carol → Bob (doc 5), Bob →
 * Carol (doc 2), Bob → Alice (doc 8).
 */
async function scenario() {
  fx = await household([1, 2, 3, 5, 6, 7, 8, 9].map((id) => makeDoc({ id, tags: [PROPAGATED] })));
  const f = fx;
  for (const id of [6, 7, 8, 9]) await f.own(id, f.bob.id);
  const wohnung = await createSpace(f.asBob, "Wohnung");
  await f.asBob.post(`/api/spaces/${wohnung}/members`).send({ member_id: f.carol.id, role: "editor" }).expect(201);
  await f.asBob.post(`/api/spaces/${wohnung}/members`).send({ member_id: f.alice.id, role: "viewer" }).expect(201);
  await f.asBob.post("/api/documents/6/move").send({ space_id: wohnung }).expect(200);
  const haushalt = await createSpace(f.asAlice, "Haushalt");
  await f.asAlice.post(`/api/spaces/${haushalt}/members`).send({ member_id: f.bob.id, role: "editor" }).expect(201);
  await f.asAlice.post("/api/documents/3/move").send({ space_id: haushalt }).expect(200);
  await f.asCarol.post("/api/documents/5/shares").send({ member_id: f.bob.id, role: "viewer" }).expect(201);
  await f.asBob.post("/api/documents/2/shares").send({ member_id: f.carol.id, role: "viewer" }).expect(201);
  await f.asBob.post("/api/documents/8/shares").send({ member_id: f.alice.id, role: "editor" }).expect(201);
  await f.paperless.deleteDocument(7);
  f.paperless.docs.delete(9);
  f.vectorStore.setSpaceByDocId.mockClear();
  return { ...f, wohnung, haushalt };
}

const homeOf = async (f: Fixture, docId: number) =>
  (await f.h.db.select().from(documentSpaces).where(eq(documentSpaces.paperlessDocId, docId)))[0]?.spaceId ?? null;

const roles = async (f: Fixture, spaceId: number) =>
  (await f.h.db.select().from(spaceMembers).where(eq(spaceMembers.spaceId, spaceId)).orderBy(asc(spaceMembers.memberId)))
    .map((r) => [r.memberId, r.role]);

const sharesOf = async (f: Fixture) =>
  (await f.h.db.select().from(documentShares).orderBy(asc(documentShares.paperlessDocId)))
    .map((s) => [s.paperlessDocId, s.memberId]);

const removeBob = (f: Fixture, body: Record<string, unknown> = { confirm_username: "bob" }) =>
  f.asAlice.post(`/api/household/members/${f.bob.id}/remove`).send(body);

describe("member removal: validation", () => {
  it("refuses a plain member (403), the admin themselves (409), a wrong confirmation and bad successors (422), unknown members (404) — and changes nothing", async () => {
    const f = await setup();
    await f.asBob.post(`/api/household/members/${f.carol.id}/remove`).send({ confirm_username: "carol" }).expect(403);
    await f.asAlice.post(`/api/household/members/${f.alice.id}/remove`).send({ confirm_username: "alice" }).expect(409);
    const wrong = await removeBob(f, { confirm_username: "carol" });
    expect(wrong.status).toBe(422);
    expect(wrong.body).toEqual({ detail: "Der Benutzername stimmt nicht überein" });
    await removeBob(f, { confirm_username: "bob", successor_member_id: f.bob.id }).expect(422);
    await removeBob(f, { confirm_username: "bob", successor_member_id: 999 }).expect(422);
    await removeBob(f, { confirm_username: "" }).expect(422);
    await f.asAlice.post("/api/household/members/999/remove").send({ confirm_username: "x" }).expect(404);
    expect(await f.h.db.select().from(memberRemovals)).toEqual([]);
    await f.asBob.get("/api/auth/me").expect(200);
    await f.asCarol.get("/api/auth/me").expect(200);
  });

  it("refuses an already removed member as successor (422) and a second removal (404)", async () => {
    const f = await setup();
    expect((await removeBob(f).expect(200)).body).toEqual({
      member_id: f.bob.id,
      successor_member_id: f.alice.id,
      status: "done",
    });
    await removeBob(f).expect(404);
    await f.asAlice
      .post(`/api/household/members/${f.carol.id}/remove`)
      .send({ confirm_username: "carol", successor_member_id: f.bob.id })
      .expect(422);
  });

  it("locks out at once: session 401, stored Paperless token gone, Paperless user inactive and groupless", async () => {
    const f = await setup();
    const bobUser = await f.paperlessUser(f.bob.id);
    const bobToken = [...f.paperless.tokens.entries()].find(([, uid]) => uid === bobUser)![0];
    expect(await f.h.db.select().from(memberPaperlessTokens).where(eq(memberPaperlessTokens.memberId, f.bob.id))).toHaveLength(1);
    await removeBob(f, { confirm_username: "bob", successor_member_id: f.carol.id }).expect(200);
    await f.asBob.get("/api/library/").expect(401);
    expect(await f.h.db.select().from(memberPaperlessTokens).where(eq(memberPaperlessTokens.memberId, f.bob.id))).toEqual([]);
    expect(f.paperless.users.get(bobUser)).toMatchObject({ is_active: false, groups: [] });
    await expect(f.paperless.forToken(bobToken).getDocument(2)).rejects.toMatchObject({ status: 401 });
    const [row] = await f.h.db.select().from(memberRemovals);
    expect(row).toMatchObject({ memberId: f.bob.id, successorId: f.carol.id, removedBy: f.alice.id, phase: "done" });
  });

  it("locks out even when Paperless is down, and reports completing", async () => {
    const f = await setup();
    const original = f.paperless.deactivateUser;
    f.paperless.deactivateUser = async () => {
      throw new Error("paperless down");
    };
    expect((await removeBob(f).expect(200)).body.status).toBe("completing");
    await f.asBob.get("/api/auth/me").expect(401);
    const list = (await f.asAlice.get("/api/household/removals").expect(200)).body as { status: string; last_error: string }[];
    expect(list).toEqual([
      expect.objectContaining({ username: "bob", successor: "alice", status: "completing", last_error: "paperless down" }),
    ]);
    f.paperless.deactivateUser = original;
    await f.h.app.get(MemberRemovalService).syncAll();
    expect(f.paperless.users.get(await f.paperlessUser(f.bob.id))?.is_active).toBe(false);
    const after = (await f.asAlice.get("/api/household/removals").expect(200)).body as { status: string; last_error: unknown }[];
    expect(after[0]).toMatchObject({ status: "done", last_error: null });
  });
});

describe("member removal: hand-over", () => {
  it("moves personal documents, hands over owned spaces, leaves others, sorts out shares", async () => {
    const f = await scenario();
    const alicePersonal = (await f.personal(f.alice.id)).id;
    expect((await removeBob(f).expect(200)).body.status).toBe("done");

    // Personal documents (incl. the trashed one) → Alice's personal space; the vanished one is forgotten.
    for (const id of [2, 7, 8]) expect(await homeOf(f, id)).toBe(alicePersonal);
    expect(await homeOf(f, 9)).toBeNull();
    expect(await homeOf(f, 6)).toBe(f.wohnung);
    // Wohnung: Alice promoted from viewer to owner, Carol stays editor, Bob gone.
    expect(await roles(f, f.wohnung)).toEqual([[f.alice.id, "owner"], [f.carol.id, "editor"]]);
    // Haushalt no longer lists Bob.
    expect(await roles(f, f.haushalt)).toEqual([[f.alice.id, "owner"]]);
    // Shares: Carol → Bob revoked, Bob → Alice ended (space role covers it), Bob → Carol kept.
    expect(await sharesOf(f)).toEqual([[2, f.carol.id]]);
    const revoked = (await f.h.db.select().from(shareAudit).where(eq(shareAudit.event, "revoked")))
      .map((a) => [a.paperlessDocId, a.memberId, a.actorMemberId])
      .sort();
    expect(revoked).toEqual([[5, f.bob.id, f.alice.id], [8, f.alice.id, f.alice.id]].sort());
    // Carol's "Von mir geteilt" no longer lists document 5; Alice sees and manages Bob's share of 2.
    expect((await f.asCarol.get("/api/shares/by-me").expect(200)).body).toEqual([]);
    expect((await f.asAlice.get("/api/documents/2/shares").expect(200)).body.map((s: { username: string }) => s.username)).toEqual(["carol"]);
    await f.asCarol.get("/api/documents/2/detail").expect(200);
  });

  it("brings Paperless and Qdrant in line", async () => {
    const f = await scenario();
    await removeBob(f).expect(200);
    const aliceUser = await f.paperlessUser(f.alice.id);
    const bobUser = await f.paperlessUser(f.bob.id);
    const carolUser = await f.paperlessUser(f.carol.id);
    const perms = (id: number) => f.paperless.permissions.get(id) as DocumentPermissions;
    for (const id of [2, 6, 7, 8]) expect(perms(id).owner).toBe(aliceUser);
    expect(perms(2).permissions.view.users).toEqual([carolUser]);
    expect(perms(5).permissions.view.users).not.toContain(bobUser);
    expect(f.paperless.users.get(bobUser)).toMatchObject({ is_active: false, groups: [] });
    // Alice is in Wohnung's writer group and out of its viewer group.
    const [wohnung] = await f.h.db.select().from(spaces).where(eq(spaces.id, f.wohnung));
    const aliceGroups = f.paperless.users.get(aliceUser)!.groups;
    expect(aliceGroups).toContain(wohnung!.paperlessGroupId);
    const viewerGroup = perms(6).permissions.view.groups.find((g) => g !== wohnung!.paperlessGroupId);
    expect(viewerGroup).toBeDefined();
    expect(aliceGroups).not.toContain(viewerGroup);
    // Qdrant: every affected, existing document got its payload rewritten.
    const alicePersonal = (await f.personal(f.alice.id)).id;
    const calls = new Map(f.vectorStore.setSpaceByDocId.mock.calls.map(([id, space]) => [id, space]));
    expect([...calls.keys()].sort()).toEqual([2, 5, 6, 7, 8]);
    expect(calls.get(2)).toEqual({ spaceId: alicePersonal, sharedWith: [f.carol.id] });
    expect(calls.get(5)).toEqual({ spaceId: (await f.personal(f.carol.id)).id, sharedWith: [] });
    expect(calls.get(8)).toEqual({ spaceId: alicePersonal, sharedWith: [] });
    // Alice reads, edits and deletes a former Bob document with her own token.
    await f.asAlice.get("/api/documents/8/detail").expect(200);
    await f.asAlice.delete("/api/documents/8").expect(204);
  });

  it("puts a trashed document back in the trash, owned by the successor, who can restore it", async () => {
    const f = await scenario();
    await removeBob(f).expect(200);
    expect(f.paperless.trashed.has(7)).toBe(true);
    expect(f.paperless.docs.has(7)).toBe(false);
    // The re-trash keeps its chunks out of Ask; the restore lets them back in.
    expect(f.vectorStore.setTrashedByDocId).toHaveBeenLastCalledWith(7, true);
    const trash = (await f.asAlice.get("/api/trash").expect(200)).body as { results: { id: number }[] };
    expect(trash.results.map((d) => d.id)).toContain(7);
    await f.asAlice.post("/api/trash/7/restore").expect(204);
    expect(f.vectorStore.setTrashedByDocId).toHaveBeenLastCalledWith(7, false);
    await f.asAlice.get("/api/documents/7/detail").expect(200);
  });

  it("is idempotent: running phase db and derived again changes nothing", async () => {
    const f = await scenario();
    await removeBob(f).expect(200);
    const snapshot = async () => ({
      homes: (await f.h.db.select().from(documentSpaces).orderBy(asc(documentSpaces.paperlessDocId))).map((r) => [r.paperlessDocId, r.spaceId]),
      roles: (await f.h.db.select().from(spaceMembers).orderBy(asc(spaceMembers.spaceId), asc(spaceMembers.memberId))).map((r) => [r.spaceId, r.memberId, r.role]),
      shares: await sharesOf(f),
      audits: (await f.h.db.select().from(shareAudit)).length,
      perms: structuredClone([...f.paperless.permissions.entries()]),
    });
    const before = await snapshot();
    await f.h.db.update(memberRemovals).set({ phase: "db" }).where(eq(memberRemovals.memberId, f.bob.id));
    await f.h.db.update(memberRemovalDocuments).set({ syncedAt: null }).where(eq(memberRemovalDocuments.memberId, f.bob.id));
    expect(await f.h.app.get(MemberRemovalService).complete(f.bob.id)).toBe("done");
    expect(await snapshot()).toEqual(before);
    expect(f.paperless.trashed.has(7)).toBe(true);
  });

  it("with a named successor, the successor owns everything and Bob's share to Alice stays", async () => {
    const f = await scenario();
    await removeBob(f, { confirm_username: "bob", successor_member_id: f.carol.id }).expect(200);
    const carolPersonal = (await f.personal(f.carol.id)).id;
    expect(await homeOf(f, 2)).toBe(carolPersonal);
    expect(await roles(f, f.wohnung)).toEqual([[f.alice.id, "viewer"], [f.carol.id, "owner"]]);
    // Carol was the recipient of 2 (now hers) → ended; Alice keeps 8.
    expect(await sharesOf(f)).toEqual([[8, f.alice.id]]);
  });
});

describe("member removal: interruptions", () => {
  it("a Paperless failure on document N leaves completing with documents < N synced; the retry skips them", async () => {
    const f = await scenario();
    const original = f.paperless.setDocumentPermissions;
    f.paperless.setDocumentPermissions = async (docId, target) => {
      if (docId === 6) throw new Error("paperless 500");
      return original(docId, target);
    };
    expect((await removeBob(f).expect(200)).body.status).toBe("completing");
    const synced = async () =>
      (await f.h.db.select().from(memberRemovalDocuments).where(eq(memberRemovalDocuments.memberId, f.bob.id)))
        .filter((r) => r.syncedAt !== null)
        .map((r) => r.paperlessDocId)
        .sort();
    expect(await synced()).toEqual([2, 5]);
    // The DB phase is done regardless: documents already belong to Alice.
    expect(await homeOf(f, 8)).toBe((await f.personal(f.alice.id)).id);
    await f.asBob.get("/api/auth/me").expect(401);

    f.paperless.setDocumentPermissions = original;
    const writesBefore = f.paperless.tenancyWrites.length;
    await f.h.app.get(MemberRemovalService).syncAll();
    expect(await synced()).toEqual([2, 5, 6, 7, 8, 9]);
    const patched = f.paperless.tenancyWrites
      .slice(writesBefore)
      .filter((w) => w.op === "setDocumentPermissions")
      .map((w) => w.target);
    expect(patched).not.toContain(2);
    expect(patched).not.toContain(5);
    const [row] = await f.h.db.select().from(memberRemovals);
    expect(row).toMatchObject({ phase: "done", lastError: null, attempts: 2 });
  });

  it("re-trashes a document whose re-trash failed after the restore", async () => {
    const f = await scenario();
    const original = f.paperless.deleteDocument;
    let fail = true;
    f.paperless.deleteDocument = async (docId) => {
      if (fail && docId === 7) throw new Error("paperless 500");
      return original(docId);
    };
    expect((await removeBob(f).expect(200)).body.status).toBe("completing");
    expect(f.paperless.docs.has(7)).toBe(true); // restored, not yet back in the trash
    fail = false;
    await f.h.app.get(MemberRemovalService).syncAll();
    expect(f.paperless.trashed.has(7)).toBe(true);
    expect(f.paperless.docs.has(7)).toBe(false);
  });

  it("two concurrent runs of the same removal share one run (lock)", async () => {
    const f = await scenario();
    const service = f.h.app.get(MemberRemovalService);
    const original = f.paperless.setDocumentPermissions;
    f.paperless.setDocumentPermissions = async () => {
      throw new Error("paperless 500");
    };
    await removeBob(f).expect(200);
    f.paperless.setDocumentPermissions = original;
    const writesBefore = f.paperless.tenancyWrites.length;
    const first = service.complete(f.bob.id);
    const second = service.complete(f.bob.id);
    expect(second).toBe(first);
    const [a, b] = await Promise.all([first, second, service.syncAll()]);
    expect([a, b]).toEqual(["done", "done"]);
    const patched = f.paperless.tenancyWrites
      .slice(writesBefore)
      .filter((w) => w.op === "setDocumentPermissions")
      .map((w) => w.target as number);
    expect(patched.length).toBeGreaterThan(0);
    expect(new Set(patched).size).toBe(patched.length);
  });
});

describe("member removal: preview and list", () => {
  it("non-admins get 403; the preview changes nothing and its counts match the removal", async () => {
    const f = await scenario();
    await f.asCarol.get(`/api/household/members/${f.bob.id}/removal-preview`).expect(403);
    await f.asCarol.get("/api/household/removals").expect(403);
    const preview = (await f.asAlice.get(`/api/household/members/${f.bob.id}/removal-preview`).expect(200)).body;
    expect(preview).toEqual({
      member_id: f.bob.id,
      username: "bob",
      successor_member_id: f.alice.id,
      successor: "alice",
      documents: 4,
      trashed: 1,
      spaces_owned: [{ id: f.wohnung, name: "Wohnung" }],
      spaces_left: [{ id: f.haushalt, name: "Haushalt" }],
      shares_revoked: 2,
      shares_kept: 1,
    });
    expect(await f.h.db.select().from(memberRemovals)).toEqual([]);
    expect((await sharesOf(f)).length).toBe(3);
    await f.asBob.get("/api/auth/me").expect(200);

    const withCarol = (await f.asAlice.get(`/api/household/members/${f.bob.id}/removal-preview?successor=${f.carol.id}`).expect(200)).body;
    expect(withCarol).toMatchObject({ successor: "carol", shares_revoked: 2, shares_kept: 1 });
    await f.asAlice.get(`/api/household/members/${f.bob.id}/removal-preview?successor=${f.bob.id}`).expect(422);
    await f.asAlice.get(`/api/household/members/${f.alice.id}/removal-preview`).expect(409);

    await removeBob(f).expect(200);
    const audits = await f.h.db.select().from(shareAudit).where(eq(shareAudit.event, "revoked"));
    expect(audits).toHaveLength(preview.shares_revoked);
    expect(await sharesOf(f)).toHaveLength(preview.shares_kept);
    await f.asAlice.get(`/api/household/members/${f.bob.id}/removal-preview`).expect(404);
  });

  it("lists removals, completing → done; the member row and audit history stay", async () => {
    const f = await setup();
    expect((await f.asAlice.get("/api/household/removals").expect(200)).body).toEqual([]);
    await f.asCarol.post("/api/documents/5/shares").send({ member_id: f.bob.id, role: "viewer" }).expect(201);
    const original = f.paperless.deactivateUser;
    f.paperless.deactivateUser = async () => {
      throw new Error("down");
    };
    await removeBob(f).expect(200);
    expect((await f.asAlice.get("/api/household/removals").expect(200)).body).toEqual([
      { member_id: f.bob.id, username: "bob", successor: "alice", removed_at: expect.any(String), status: "completing", last_error: "down" },
    ]);
    f.paperless.deactivateUser = original;
    await f.h.app.get(MemberRemovalService).syncAll();
    expect((await f.asAlice.get("/api/household/removals").expect(200)).body[0]).toMatchObject({ status: "done", last_error: null });
    expect(await f.h.db.select().from(members).where(eq(members.id, f.bob.id))).toHaveLength(1);
    const audit = (await f.asCarol.get("/api/documents/5/shares/audit").expect(200)).body as { member: string; event: string }[];
    expect(audit.map((a) => a.event)).toEqual(expect.arrayContaining(["granted", "revoked"]));
    expect(JSON.stringify(audit)).toContain("bob");
  });
});

describe("member removal: open live-counts stream", () => {
  it("ends a removed member's open stream with session_ended instead of polling on", { timeout: 20_000 }, async () => {
    const f = await setup();
    const stream = f.asBob
      .get("/api/events/counts")
      .buffer(true)
      .parse((res, done) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => done(null, body));
      })
      .then((res) => res.body as string);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await markRemoved(f, f.bob.id);
    const body = await stream;
    expect(body).toMatch(/^data: \{/m); // counts before the removal
    // A removed member's session counts as revoked.
    expect(body).toContain("event: session_ended\ndata: revoked\n\n");
    // Reconnecting is refused by the guard.
    await f.asBob.get("/api/events/counts").expect(401);
  });
});

describe("member removal: sessions", () => {
  it("revokes every session of the removed member in the lockout step, audited with the admin as actor", async () => {
    const f = await setup();
    // A second device for bob (his enrolment already ended the password session).
    await passkeyLogin(f.h.app, f.asBob.enrolled!.authenticator);
    const before = (await f.h.db.select().from(sessions).where(eq(sessions.memberId, f.bob.id))).filter(
      (row) => row.revokedAt === null,
    );
    expect(before).toHaveLength(2);

    await removeBob(f, { confirm_username: "bob" }).expect(200);

    const after = (await f.h.db.select().from(sessions).where(eq(sessions.memberId, f.bob.id))).filter((row) =>
      before.some((b) => b.id === row.id),
    );
    expect(after).toHaveLength(2);
    for (const row of after) {
      expect(row.revokedAt).not.toBeNull();
      expect(row.revokedReason).toBe("member_removed");
    }
    const audit = (await f.h.db.select().from(authAudit).where(eq(authAudit.event, "session_revoked"))).filter((row) => row.reason === "member_removed");
    expect(audit.map((row) => [row.memberId, row.actorMemberId, row.reason]).sort()).toEqual([
      [f.bob.id, f.alice.id, "member_removed"],
      [f.bob.id, f.alice.id, "member_removed"],
    ]);
    // Other members' sessions are untouched.
    await f.asCarol.get("/api/auth/me").expect(200);
  });
});
