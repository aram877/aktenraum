import { afterEach, describe, expect, it, vi } from "vitest";

import type { Principal } from "../auth/principal.js";
import { EventsService } from "../events/events.service.js";
import { searchWithinIds, sortDocuments } from "../library/library.service.js";
import type { PaperlessDocument } from "../paperless/paperless.gateway.js";
import { FakeGateway, TAGS, makeDoc } from "../test/fake-gateway.js";
import type { Harness } from "../test/harness.js";
import { createSpace, household as makeHousehold } from "../test/household.js";

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

const PROPAGATED = TAGS["ai-propagated"] as number;
const PENDING = TAGS["ai-pending"] as number;

/** Docs 1–3, 5 propagated; 6 pending (Alice's) — see test/household.ts. */
async function household() {
  const result = await makeHousehold([
    ...[1, 2, 3, 5].map((id) => makeDoc({ id, tags: [PROPAGATED] })),
    makeDoc({ id: 6, tags: [PENDING] }),
  ]);
  harness = result.h;
  await result.own(6, result.alice.id);
  return result;
}

function principalOf(memberId: number, userId: number, role: "admin" | "member"): Principal {
  return {
    kind: "member",
    memberId,
    userId,
    householdId: 1,
    username: "x",
    householdRole: role,
    scopes: new Set(),
    sessionId: null,
    authTime: null,
    clientId: "spa",
  };
}

const ids = (body: { results: { id: number }[] }) => body.results.map((r) => r.id).sort((a, b) => a - b);

describe("library: space column and filter", { timeout: 60_000 }, () => {
  it("every row carries its home space", async () => {
    const { asAlice, alice, personal } = await household();
    const id = await createSpace(asAlice);
    await asAlice.post("/api/documents/1/move").send({ space_id: id }).expect(200);

    const rows = (await asAlice.get("/api/library/").expect(200)).body.results as {
      id: number;
      home_space: unknown;
    }[];
    const byId = new Map(rows.map((r) => [r.id, r.home_space]));
    expect(byId.get(1)).toEqual({ id, name: "Haushalt", kind: "shared" });
    expect(byId.get(3)).toEqual({ id: (await personal(alice.id)).id, name: "Persönlich", kind: "personal" });
  });

  it("?space= lists only that space and only for its members", async () => {
    const { asAlice, asBob, bob } = await household();
    const id = await createSpace(asAlice);
    await asAlice.post("/api/documents/1/move").send({ space_id: id }).expect(200);

    expect(ids((await asAlice.get(`/api/library/?space=${id}`).expect(200)).body)).toEqual([1]);
    await asBob.get(`/api/library/?space=${id}`).expect(403);
    await asAlice.get("/api/library/?space=abc").expect(422);
    await asAlice.post(`/api/spaces/${id}/members`).send({ member_id: bob.id, role: "viewer" }).expect(201);
    expect(ids((await asBob.get(`/api/library/?space=${id}`).expect(200)).body)).toEqual([1]);

    const empty = await createSpace(asAlice, "Leer");
    expect((await asAlice.get(`/api/library/?space=${empty}`).expect(200)).body).toMatchObject({ results: [], total: 0 });
  });
});

describe("searchWithinIds (id__in safety net)", () => {
  const docs: PaperlessDocument[] = [
    makeDoc({ id: 1, title: "Delta", created_date: "2026-01-04" }),
    makeDoc({ id: 2, title: "alpha", created_date: "2026-01-02" }),
    makeDoc({ id: 3, title: "Charlie", created_date: "2026-01-05" }),
    makeDoc({ id: 4, title: "bravo", created_date: "2026-01-01" }),
    makeDoc({ id: 5, title: "Echo", created_date: "2026-01-03" }),
  ];

  it("sends one id__in up to the limit", async () => {
    const gateway = new FakeGateway({ docs });
    const spy = vi.spyOn(gateway, "searchDocuments");
    const out = await searchWithinIds(gateway, {}, [1, 2, 3], { page: 1, pageSize: 25, ordering: "-created" }, 3);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ id__in: "1,2,3" });
    expect(out.count).toBe(3);
  });

  it("above the limit: chunks, merges in the requested order and paginates", async () => {
    const gateway = new FakeGateway({ docs });
    const spy = vi.spyOn(gateway, "searchDocuments");
    const all = [1, 2, 3, 4, 5];

    const page1 = await searchWithinIds(gateway, {}, all, { page: 1, pageSize: 2, ordering: "-created" }, 2);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls.map((c) => c[0].id__in)).toEqual(["1,2", "3,4", "5"]);
    expect(page1.count).toBe(5);
    expect(page1.results.map((d) => d.id)).toEqual([3, 1]);

    const page3 = await searchWithinIds(gateway, {}, all, { page: 3, pageSize: 2, ordering: "-created" }, 2);
    expect(page3.results.map((d) => d.id)).toEqual([4]);
    expect(sortDocuments(docs, "title").map((d) => d.id)).toEqual([2, 4, 3, 1, 5]);
  });
});

describe("review inbox: viewers don't review", { timeout: 60_000 }, () => {
  it("a viewer's inbox and inbox count exclude the space's pending documents; the library still shows them", async () => {
    const { h, asAlice, asBob, bob } = await household();
    const id = await createSpace(asAlice);
    await asAlice.post("/api/documents/6/move").send({ space_id: id }).expect(200);
    await asAlice.post(`/api/spaces/${id}/members`).send({ member_id: bob.id, role: "viewer" }).expect(201);
    const events = h.app.get(EventsService);

    expect(ids((await asBob.get("/api/inbox/").expect(200)).body)).toEqual([]);
    expect((await events.computeCounts(principalOf(bob.id, bob.userId, "member"))).inbox).toBe(0);
    await asBob.get("/api/inbox/6").expect(200); // read is allowed
    await asBob.post("/api/inbox/6/approve").send({}).expect(404);

    await asAlice.patch(`/api/spaces/${id}/members/${bob.id}`).send({ role: "editor" }).expect(200);
    expect(ids((await asBob.get("/api/inbox/").expect(200)).body)).toEqual([6]);
    expect((await events.computeCounts(principalOf(bob.id, bob.userId, "member"))).inbox).toBe(1);
  });

  it("the owner and a single-space member see their inbox unchanged", async () => {
    const { h, asAlice, alice, asCarol, carol } = await household();
    expect(ids((await asAlice.get("/api/inbox/").expect(200)).body)).toEqual([6]);
    expect(ids((await asCarol.get("/api/inbox/").expect(200)).body)).toEqual([]);
    const events = h.app.get(EventsService);
    expect((await events.computeCounts(principalOf(alice.id, alice.userId, "admin"))).inbox).toBe(1);
    expect((await events.computeCounts(principalOf(carol.id, carol.userId, "member"))).inbox).toBe(0);
  });
});
