import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { AiService } from "../ai/ai.service.js";
import type { MemberPrincipal } from "../auth/principal.js";
import { documentShares, shareAudit } from "../db/schema.js";
import { EventsService } from "../events/events.service.js";
import { TAGS, makeDoc } from "../test/fake-gateway.js";
import type { Harness } from "../test/harness.js";
import { createSpace, household as makeHousehold } from "../test/household.js";
import { TenancyController } from "../tenancy/tenancy.controller.js";
import { SharesService } from "./shares.service.js";

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

const PROPAGATED = TAGS["ai-propagated"] as number;
const PENDING = TAGS["ai-pending"] as number;

/** Alice: 1, 3, 6 (pending). Bob: 2. Carol: 5 — see test/household.ts. */
async function household() {
  const result = await makeHousehold([
    ...[1, 2, 3, 5].map((id) => makeDoc({ id, tags: [PROPAGATED] })),
    makeDoc({ id: 6, tags: [PENDING] }),
  ]);
  harness = result.h;
  await result.own(6, result.alice.id);
  return result;
}

type Household = Awaited<ReturnType<typeof household>>;

const FAR_FUTURE = "2099-12-31T22:59:59.000Z";

const libraryIds = async (agent: Household["asAlice"]) =>
  ((await agent.get("/api/library/").expect(200)).body.results as { id: number }[])
    .map((r) => r.id)
    .sort((a, b) => a - b);

async function auditOf(h: Harness, docId: number) {
  return h.db.select().from(shareAudit).where(eq(shareAudit.paperlessDocId, docId));
}

function principalOf(memberId: number): MemberPrincipal {
  return {
    kind: "member",
    memberId,
    userId: memberId,
    householdId: 1,
    username: "x",
    householdRole: "member",
    scopes: new Set(),
    sessionId: null,
    authTime: null,
    clientId: "spa",
  };
}

describe("granting a share", { timeout: 60_000 }, () => {
  it("viewer share: the recipient reads, previews, downloads — DB, Paperless and Qdrant agree", async () => {
    const { h, paperless, vectorStore, asAlice, asBob, alice, bob, paperlessUser, personal } = await household();
    await asBob.get("/api/documents/1/detail").expect(404);

    const created = await asAlice.post("/api/documents/1/shares").send({ member_id: bob.id, role: "viewer" }).expect(201);
    expect(created.body).toMatchObject({ member_id: bob.id, username: "bob", role: "viewer", expires_at: null, granted_by: "alice" });

    const detail = (await asBob.get("/api/documents/1/detail").expect(200)).body;
    expect(detail.access).toEqual({ via: "share", role: "viewer" });
    expect(detail.home_space).toBeNull();
    expect(detail.shared_by).toEqual({ username: "alice", role: "viewer", expires_at: null });
    await asBob.get("/api/documents/1/preview").expect(200);
    await asBob.get("/api/documents/1/download").expect(200);
    await asBob.patch("/api/documents/1/fields").send({ ai_title: "x" }).expect(404);

    const bobUser = await paperlessUser(bob.id);
    expect(paperless.permissions.get(1)!.permissions.view.users).toEqual([bobUser]);
    expect(paperless.permissions.get(1)!.permissions.change.users).toEqual([]);
    const home = (await personal(alice.id)).id;
    expect(vectorStore.setSpaceByDocId).toHaveBeenLastCalledWith(1, { spaceId: home, sharedWith: [bob.id] });
    expect(await h.app.get(TenancyController).documentSpace(1)).toMatchObject({ space_id: home, shared_with: [bob.id] });

    // The owner keeps seeing "space" access.
    expect((await asAlice.get("/api/documents/1/detail").expect(200)).body.access).toEqual({ via: "space", role: "owner" });
    expect((await auditOf(h, 1)).map((a) => a.event)).toContain("granted");
  });

  it("editor share: corrects AI and type fields, but can't approve, reprocess, star, delete, move or re-share", async () => {
    const { paperless, asAlice, asBob, bob, carol, paperlessUser } = await household();
    await asAlice.post("/api/documents/6/shares").send({ member_id: bob.id, role: "editor" }).expect(201);
    expect(paperless.permissions.get(6)!.permissions.change.users).toEqual([await paperlessUser(bob.id)]);

    await asBob.patch("/api/documents/6/fields").send({ ai_title: "Korrigiert" }).expect(200);
    await asBob.patch("/api/documents/6/type-fields").send({ document_type: "Rechnung", fields: { rechnungsnummer: "R-1" } }).expect(200);

    await asBob.post("/api/inbox/6/approve").send({}).expect(404);
    await asBob.post("/api/inbox/6/reject").expect(404);
    await asBob.post("/api/documents/6/reprocess").expect(404);
    await asBob.post("/api/documents/6/star").expect(404);
    await asBob.post("/api/documents/6/dismiss-duplicate").expect(404);
    await asBob.delete("/api/documents/6").expect(404);
    const bobsSpace = (await asBob.get("/api/spaces").expect(200)).body.spaces[0].id;
    await asBob.post("/api/documents/6/move").send({ space_id: bobsSpace }).expect(403);
    await asBob.post("/api/documents/6/shares").send({ member_id: carol.id, role: "viewer" }).expect(404);
    await asBob.get("/api/documents/6/shares").expect(404);
    await asBob.get("/api/documents/6/shares/audit").expect(404);
  });

  it("refuses self, unknown members, members of the home space, duplicates and past expiries", async () => {
    const { h, asAlice, asCarol, alice, bob, carol } = await household();
    await asAlice.post("/api/documents/1/shares").send({ member_id: alice.id, role: "viewer" }).expect(422);
    await asAlice.post("/api/documents/1/shares").send({ member_id: 999, role: "viewer" }).expect(422);
    await asAlice.post("/api/documents/1/shares").send({ member_id: bob.id, role: "owner" }).expect(422);
    await asAlice
      .post("/api/documents/1/shares")
      .send({ member_id: bob.id, role: "viewer", expires_at: "2000-01-01T00:00:00Z" })
      .expect(422);

    await asAlice.post("/api/documents/1/shares").send({ member_id: bob.id, role: "viewer" }).expect(201);
    await asAlice.post("/api/documents/1/shares").send({ member_id: bob.id, role: "editor" }).expect(409);
    const [row] = await h.db.select().from(documentShares).where(eq(documentShares.memberId, bob.id));
    expect(row!.role).toBe("viewer");

    // Carol edits "Haushalt": she reaches its documents through the space already.
    const haushalt = await createSpace(asAlice);
    await asAlice.post(`/api/spaces/${haushalt}/members`).send({ member_id: carol.id, role: "editor" }).expect(201);
    await asAlice.post("/api/documents/3/move").send({ space_id: haushalt }).expect(200);
    await asAlice.post("/api/documents/3/shares").send({ member_id: carol.id, role: "viewer" }).expect(409);
    // ...and as a space editor she may not share its documents.
    await asCarol.post("/api/documents/3/shares").send({ member_id: bob.id, role: "viewer" }).expect(404);
    // An outsider learns nothing.
    await asCarol.post("/api/documents/1/shares").send({ member_id: bob.id, role: "viewer" }).expect(404);
  });
});

describe("changing and revoking", { timeout: 60_000 }, () => {
  it("downgrade editor → viewer takes effect on the next request; expiry changes are audited", async () => {
    const { h, asAlice, asBob, bob } = await household();
    await asAlice.post("/api/documents/1/shares").send({ member_id: bob.id, role: "editor" }).expect(201);
    await asBob.patch("/api/documents/1/fields").send({ ai_title: "a" }).expect(200);

    const changed = await asAlice.patch(`/api/documents/1/shares/${bob.id}`).send({ role: "viewer", expires_at: FAR_FUTURE }).expect(200);
    expect(changed.body.role).toBe("viewer");
    // pg-mem shifts stored timestamps by the local UTC offset (CLAUDE.md), so only presence is checked here.
    expect(changed.body.expires_at).toEqual(expect.any(String));
    await asBob.patch("/api/documents/1/fields").send({ ai_title: "b" }).expect(404);

    await asAlice.patch(`/api/documents/1/shares/${bob.id}`).send({ expires_at: null }).expect(200);
    await asAlice.patch(`/api/documents/1/shares/${bob.id}`).send({ expires_at: "2000-01-01T00:00:00Z" }).expect(422);
    await asAlice.patch(`/api/documents/1/shares/${bob.id}`).send({}).expect(422);
    await asAlice.patch("/api/documents/1/shares/999").send({ role: "viewer" }).expect(404);
    expect((await auditOf(h, 1)).map((a) => a.event).sort()).toEqual(
      ["expiry_changed", "expiry_changed", "granted", "role_changed"],
    );
  });

  it("revoke: 404 for the recipient, gone from the library, Paperless and Qdrant", async () => {
    const { h, paperless, vectorStore, asAlice, asBob, alice, bob, paperlessUser, personal } = await household();
    await asAlice.post("/api/documents/1/shares").send({ member_id: bob.id, role: "viewer" }).expect(201);
    expect(await libraryIds(asBob)).toContain(1);

    await asAlice.delete(`/api/documents/1/shares/${bob.id}`).expect(204);

    await asBob.get("/api/documents/1/detail").expect(404);
    expect(await libraryIds(asBob)).not.toContain(1);
    expect(paperless.visibleTo(await paperlessUser(bob.id))).not.toContain(1);
    expect(vectorStore.setSpaceByDocId).toHaveBeenLastCalledWith(1, { spaceId: (await personal(alice.id)).id, sharedWith: [] });
    expect((await auditOf(h, 1)).map((a) => a.event)).toContain("revoked");
    await asAlice.delete(`/api/documents/1/shares/${bob.id}`).expect(404);
  });

  it("Paperless failure undoes a grant with 502", async () => {
    const { h, paperless, vectorStore, asAlice, bob } = await household();
    const before = structuredClone(paperless.permissions.get(1));
    const original = paperless.setDocumentPermissions;
    let calls = 0;
    paperless.setDocumentPermissions = async (docId, target) => {
      calls += 1;
      if (calls === 1) throw new Error("paperless down");
      return original(docId, target);
    };

    await asAlice.post("/api/documents/1/shares").send({ member_id: bob.id, role: "viewer" }).expect(502);

    expect(await h.db.select().from(documentShares)).toEqual([]);
    expect(paperless.permissions.get(1)).toEqual(before);
    // The compensation re-syncs Qdrant to the restored state: nobody shared.
    expect(vectorStore.setSpaceByDocId).toHaveBeenLastCalledWith(1, expect.objectContaining({ sharedWith: [] }));
    expect(await auditOf(h, 1)).toEqual([]);
  });

  it("Qdrant failure undoes a revoke with 502: the share and the Paperless grant stay", async () => {
    const { h, paperless, vectorStore, asAlice, asBob, bob, paperlessUser } = await household();
    await asAlice.post("/api/documents/1/shares").send({ member_id: bob.id, role: "viewer" }).expect(201);
    vectorStore.setSpaceByDocId.mockImplementationOnce(async () => {
      throw new Error("qdrant down");
    });

    await asAlice.delete(`/api/documents/1/shares/${bob.id}`).expect(502);

    expect(await h.db.select().from(documentShares)).toHaveLength(1);
    expect(paperless.visibleTo(await paperlessUser(bob.id))).toContain(1);
    await asBob.get("/api/documents/1/detail").expect(200);
  });
});

describe("share lists", { timeout: 60_000 }, () => {
  it("with-me and by-me; trashed documents are left out", async () => {
    const { asAlice, asBob, asCarol, bob, carol } = await household();
    await asAlice.post("/api/documents/1/shares").send({ member_id: bob.id, role: "viewer" }).expect(201);
    await asAlice.post("/api/documents/3/shares").send({ member_id: bob.id, role: "editor", expires_at: FAR_FUTURE }).expect(201);
    await asAlice.post("/api/documents/3/shares").send({ member_id: carol.id, role: "viewer" }).expect(201);

    const withMe = (await asBob.get("/api/shares/with-me").expect(200)).body;
    expect(withMe).toEqual([
      { doc_id: 1, title: expect.any(String), shared_by: "alice", role: "viewer", expires_at: null },
      { doc_id: 3, title: expect.any(String), shared_by: "alice", role: "editor", expires_at: expect.any(String) },
    ]);
    const byMe = (await asAlice.get("/api/shares/by-me").expect(200)).body as { doc_id: number; member: { username: string } }[];
    expect(byMe.map((s) => [s.doc_id, s.member.username])).toEqual([[1, "bob"], [3, "bob"], [3, "carol"]]);
    expect((await asBob.get("/api/shares/by-me").expect(200)).body).toEqual([]);
    expect((await asAlice.get("/api/documents/3/shares").expect(200)).body.map((s: { username: string }) => s.username)).toEqual(["bob", "carol"]);

    await asAlice.delete("/api/documents/1").expect(204);
    expect((await asBob.get("/api/shares/with-me").expect(200)).body.map((s: { doc_id: number }) => s.doc_id)).toEqual([3]);
    expect((await asCarol.get("/api/shares/with-me").expect(200)).body.map((s: { doc_id: number }) => s.doc_id)).toEqual([3]);
  });

  it("by-me follows a move into a space someone else owns", async () => {
    const { asAlice, asCarol, alice, bob } = await household();
    await asAlice.post("/api/documents/1/shares").send({ member_id: bob.id, role: "viewer" }).expect(201);
    const carols = await createSpace(asCarol, "Carols Akte");
    await asCarol.post(`/api/spaces/${carols}/members`).send({ member_id: alice.id, role: "editor" }).expect(201);
    await asAlice.post("/api/documents/1/move").send({ space_id: carols }).expect(200);

    expect((await asAlice.get("/api/shares/by-me").expect(200)).body).toEqual([]);
    expect((await asCarol.get("/api/shares/by-me").expect(200)).body.map((s: { doc_id: number }) => s.doc_id)).toEqual([1]);
    // Only the new owner manages it now.
    await asAlice.get("/api/documents/1/shares").expect(404);
    await asCarol.get("/api/documents/1/shares").expect(200);
  });

  it("a move keeps the recipients in Paperless and in the Qdrant shared_with", async () => {
    const { paperless, vectorStore, asAlice, asBob, bob, paperlessUser } = await household();
    await asAlice.post("/api/documents/1/shares").send({ member_id: bob.id, role: "viewer" }).expect(201);
    const haushalt = await createSpace(asAlice);
    await asAlice.post("/api/documents/1/move").send({ space_id: haushalt }).expect(200);

    expect(vectorStore.setSpaceByDocId).toHaveBeenLastCalledWith(1, { spaceId: haushalt, sharedWith: [bob.id] });
    expect(paperless.permissions.get(1)!.permissions.view.users).toEqual([await paperlessUser(bob.id)]);
    await asBob.get("/api/documents/1/detail").expect(200);
  });
});

describe("expiry", { timeout: 60_000 }, () => {
  const expire = (h: Harness, docId: number, memberId: number) =>
    h.db.execute(sql`UPDATE document_shares SET expires_at = now() - interval '1 minute'
      WHERE paperless_doc_id = ${docId} AND member_id = ${memberId}`);

  it("an expired share is gone on the next request: detail, library, with-me, Paperless, Qdrant", async () => {
    const { h, paperless, vectorStore, asAlice, asBob, alice, bob, paperlessUser, personal } = await household();
    await asAlice.post("/api/documents/1/shares").send({ member_id: bob.id, role: "viewer", expires_at: FAR_FUTURE }).expect(201);
    expect(await libraryIds(asBob)).toContain(1);

    await expire(h, 1, bob.id);
    // Policy decides in SQL: access ends at the expiry instant, before any sweep.
    await asBob.get("/api/documents/1/detail").expect(404);
    expect(await h.db.select().from(documentShares)).toHaveLength(1);

    // The library's caller-scoped sweep removes the Paperless grant first.
    expect(await libraryIds(asBob)).not.toContain(1);
    expect(await h.db.select().from(documentShares)).toEqual([]);
    expect(paperless.visibleTo(await paperlessUser(bob.id))).not.toContain(1);
    expect(vectorStore.setSpaceByDocId).toHaveBeenLastCalledWith(1, { spaceId: (await personal(alice.id)).id, sharedWith: [] });
    expect((await asBob.get("/api/shares/with-me").expect(200)).body).toEqual([]);
    const expired = (await auditOf(h, 1)).find((a) => a.event === "expired");
    expect(expired).toMatchObject({ memberId: bob.id, actorMemberId: null });
  });

  it("the sweep keeps the row when the re-mirror fails, and retries", async () => {
    const { h, paperless, asAlice, bob } = await household();
    await asAlice.post("/api/documents/1/shares").send({ member_id: bob.id, role: "viewer" }).expect(201);
    await expire(h, 1, bob.id);
    const original = paperless.setDocumentPermissions;
    paperless.setDocumentPermissions = async () => {
      throw new Error("paperless down");
    };
    const shares = h.app.get(SharesService);

    expect(await shares.expireDue()).toBe(0);
    expect(await h.db.select().from(documentShares)).toHaveLength(1);

    paperless.setDocumentPermissions = original;
    expect(await shares.expireDue()).toBe(1);
    expect(await h.db.select().from(documentShares)).toEqual([]);
  });

  it("Ask: an expired share's document is no longer a candidate for the recipient", async () => {
    const { h, asAlice, bob } = await household();
    await asAlice.post("/api/documents/1/shares").send({ member_id: bob.id, role: "viewer" }).expect(201);
    const ai = h.app.get(AiService);
    const bobPrincipal = { ...principalOf(bob.id), userId: bob.userId };
    const idsFor = async () => {
      await ai.expireSharesFor(bobPrincipal);
      const [results] = await ai.executeFilter(bobPrincipal, {
        document_type: null,
        correspondent: null,
        date_from: null,
        date_to: null,
        text: null,
        tags: [],
      } as never);
      return results.map((r) => r.id);
    };
    expect(await idsFor()).toContain(1);
    await expire(h, 1, bob.id);
    expect(await idsFor()).not.toContain(1);
  });
});

describe("access audit", { timeout: 60_000 }, () => {
  const accessed = async (h: Harness, docId: number, memberId: number) =>
    (
      await h.db
        .select()
        .from(shareAudit)
        .where(and(eq(shareAudit.paperlessDocId, docId), eq(shareAudit.memberId, memberId), eq(shareAudit.event, "accessed")))
    ).map((a) => a.accessKind).sort();

  it("one entry per kind and hour; space members aren't logged; the owner reads the log", async () => {
    const { h, asAlice, asBob, alice, bob } = await household();
    await asAlice.post("/api/documents/1/shares").send({ member_id: bob.id, role: "viewer" }).expect(201);

    await asBob.get("/api/documents/1/download").expect(200);
    await asBob.get("/api/documents/1/download").expect(200);
    await asBob.get("/api/documents/1/detail").expect(200);
    await asBob.get("/api/documents/1/preview").expect(200);
    await asAlice.get("/api/documents/1/download").expect(200);

    expect(await accessed(h, 1, bob.id)).toEqual(["detail", "download", "preview"]);
    expect(await accessed(h, 1, alice.id)).toEqual([]);

    const log = (await asAlice.get("/api/documents/1/shares/audit").expect(200)).body as { event: string; access_kind: string | null; member: string }[];
    expect(log.filter((e) => e.event === "accessed").map((e) => e.access_kind).sort()).toEqual(["detail", "download", "preview"]);
    expect(log.every((e) => e.member === "bob")).toBe(true);
  });

  it("Ask citations of shared documents are audited as 'ask'", async () => {
    const { h, asAlice, alice, bob } = await household();
    await asAlice.post("/api/documents/1/shares").send({ member_id: bob.id, role: "viewer" }).expect(201);
    const ai = h.app.get(AiService);
    await ai.auditSharedCitations(principalOf(bob.id), [{ id: 1 }, { id: 2 }]);
    await ai.auditSharedCitations(principalOf(alice.id), [{ id: 1 }]);
    expect(await accessed(h, 1, bob.id)).toEqual(["ask"]);
    expect(await accessed(h, 2, bob.id)).toEqual([]);
    expect(await accessed(h, 1, alice.id)).toEqual([]);
  });

  it("a failing audit write never fails the request", async () => {
    const { h, asAlice, asBob, bob } = await household();
    await asAlice.post("/api/documents/1/shares").send({ member_id: bob.id, role: "viewer" }).expect(201);
    await h.db.execute(sql`DROP TABLE share_audit`);
    await asBob.get("/api/documents/1/download").expect(200);
  });
});

describe("library, inbox and live counts", { timeout: 60_000 }, () => {
  it("the recipient's row says who shared it and never names the sharer's space", async () => {
    const { asAlice, asBob, bob } = await household();
    const haushalt = await createSpace(asAlice, "Geheime Akte");
    await asAlice.post("/api/documents/3/move").send({ space_id: haushalt }).expect(200);
    await asAlice.post("/api/documents/3/shares").send({ member_id: bob.id, role: "viewer" }).expect(201);

    const body = (await asBob.get("/api/library/").expect(200)).body as { results: { id: number; home_space: unknown; shared_by: unknown }[] };
    const row = body.results.find((r) => r.id === 3)!;
    expect(row.home_space).toBeNull();
    expect(row.shared_by).toEqual({ username: "alice", role: "viewer", expires_at: null });
    expect(JSON.stringify(body)).not.toContain("Geheime Akte");
    const own = body.results.find((r) => r.id === 2)!;
    expect(own.shared_by).toBeNull();
    // The space filter only covers the caller's spaces.
    await asBob.get(`/api/library/?space=${haushalt}`).expect(403);
    const detail = (await asBob.get("/api/documents/3/detail").expect(200)).body;
    expect(JSON.stringify(detail)).not.toContain("Geheime Akte");
  });

  it("a pending shared document stays out of the recipient's inbox and inbox count", async () => {
    const { h, asAlice, asBob, alice, bob } = await household();
    await asAlice.post("/api/documents/6/shares").send({ member_id: bob.id, role: "editor" }).expect(201);

    const inboxIds = async (agent: Household["asAlice"]) =>
      ((await agent.get("/api/inbox/").expect(200)).body.results as { id: number }[]).map((r) => r.id);
    expect(await inboxIds(asBob)).toEqual([]);
    expect(await inboxIds(asAlice)).toEqual([6]);

    const events = h.app.get(EventsService);
    expect((await events.computeCounts({ ...principalOf(bob.id), userId: bob.userId })).inbox).toBe(0);
    expect((await events.computeCounts({ ...principalOf(alice.id), userId: alice.userId, householdRole: "admin" })).inbox).toBe(1);
  });
});

describe("a shared document never feeds the recipient's corpus", { timeout: 60_000 }, () => {
  const twin = (id: number) =>
    makeDoc({
      id,
      tags: [PROPAGATED],
      custom_fields: [
        { field: 10, value: "Stadtwerke München" },
        { field: 11, value: "Rechnung" },
        { field: 13, value: "2026-03-15" },
        { field: 17, value: "RE-4711" },
      ],
    });

  it("not a space peer (few-shot / history) and not a duplicate candidate of Bob's twin", async () => {
    const result = await makeHousehold([twin(1), twin(2), makeDoc({ id: 3, tags: [PROPAGATED] }), makeDoc({ id: 5, tags: [PROPAGATED] })]);
    harness = result.h;
    const { h, asAlice, asBob, bob } = result;
    await asAlice.post("/api/documents/1/shares").send({ member_id: bob.id, role: "viewer" }).expect(201);

    const peers = await h.app.get(TenancyController).documentSpace(2);
    expect(peers.space_document_ids).toEqual([2]);
    const candidates = (await asBob.get("/api/documents/2/duplicate-candidates").expect(200)).body.candidates as { id: number }[];
    expect(candidates.map((c) => c.id)).not.toContain(1);
    // ...and Bob's documents don't become Alice's duplicates either.
    const fromAlice = (await asAlice.get("/api/documents/1/duplicate-candidates").expect(200)).body.candidates as { id: number }[];
    expect(fromAlice.map((c) => c.id)).not.toContain(2);
  });
});
