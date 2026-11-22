import { and, eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { authRateLimitEvents, credentialAudit, personalAccessTokens, sessions, shareAudit } from "../db/schema.js";
import { household } from "../test/household.js";
import { AuthSweepService } from "./auth-sweep.service.js";
import { DISPLAY_PREFIX_LENGTH, MAX_ACTIVE_TOKENS, TokenService } from "./tokens.service.js";

type Fixture = Awaited<ReturnType<typeof household>>;
type Agent = Fixture["asAlice"];

let fx: Fixture | null = null;

afterEach(async () => {
  await fx?.h.close();
  fx = null;
});

async function setup(): Promise<Fixture> {
  fx = await household();
  return fx;
}

const ago = (interval: string) => sql.raw(`now() - interval '${interval}'`) as unknown as string;

async function createToken(
  agent: Agent,
  body: Record<string, unknown> = {},
): Promise<{ id: number; value: string; body: Record<string, unknown> }> {
  const response = await agent
    .post("/api/auth/tokens")
    .send({ name: "Scanner", scopes: ["documents:read"], expires_in_days: 90, ...body })
    .expect(201);
  return { id: response.body.token.id as number, value: response.body.value as string, body: response.body };
}

/** A request with only the bearer header (no cookie jar). */
function bearer(f: Fixture, method: "get" | "post" | "delete" | "patch", url: string, value: string, ip = "198.51.100.7") {
  return request(f.h.app.getHttpServer())[method](url).set("Authorization", `Bearer ${value}`).set("X-Forwarded-For", ip);
}

/** Ends the agent's step-up window without ending the session. */
async function staleStepUp(f: Fixture, memberId: number): Promise<void> {
  await f.h.db.update(sessions).set({ stepUpAt: ago("10 minutes") }).where(eq(sessions.memberId, memberId));
}

// ---------------------------------------------------------------------------
// Token routes (D8)
// ---------------------------------------------------------------------------

describe("token routes", () => {
  it("creates a token: the value comes back once, the list never shows it", async () => {
    const f = await setup();
    const created = await createToken(f.asBob, { name: "Scanner", scopes: ["upload"], expires_in_days: 90 });
    expect(created.value).toMatch(/^akt_pat_[A-Za-z0-9_-]{43}$/);
    expect(created.body.token).toMatchObject({ name: "Scanner", scopes: ["upload"], state: "active", last_used_at: null });

    const list = await f.asBob.get("/api/auth/tokens").expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: created.id, name: "Scanner", display_prefix: created.value.slice(0, DISPLAY_PREFIX_LENGTH) });
    expect(JSON.stringify(list.body)).not.toContain(created.value);
    // Members see only their own tokens.
    expect((await f.asCarol.get("/api/auth/tokens").expect(200)).body).toEqual([]);
  });

  it("refuses bad names, scopes and expiries with 422 and creates nothing", async () => {
    const f = await setup();
    const bad: Record<string, unknown>[] = [
      { name: "" },
      { name: "   " },
      { name: "x".repeat(65) },
      { scopes: [] },
      { scopes: ["household:admin"] },
      { scopes: ["settings:write"] },
      { scopes: ["bogus"] },
      { scopes: ["upload", "upload"] },
      { expires_in_days: 0 },
      { expires_in_days: 366 },
      { expires_in_days: 1.5 },
      { expires_in_days: "30" },
    ];
    for (const body of bad) {
      await f.asBob
        .post("/api/auth/tokens")
        .send({ name: "t", scopes: ["upload"], expires_in_days: 30, ...body })
        .expect(422);
    }
    expect(await f.h.db.select().from(personalAccessTokens)).toEqual([]);
  });

  it("needs a fresh step-up to create, but not to revoke", async () => {
    const f = await setup();
    const { id, value } = await createToken(f.asBob);
    await staleStepUp(f, f.bob.id);

    const refused = await f.asBob.post("/api/auth/tokens").send({ name: "t", scopes: ["upload"], expires_in_days: 1 });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ detail: "step_up_required" });
    expect(await f.h.db.select().from(personalAccessTokens)).toHaveLength(1);

    await bearer(f, "get", "/api/library/", value).expect(200);
    await f.asBob.delete(`/api/auth/tokens/${id}`).expect(204);
    await f.asBob.delete(`/api/auth/tokens/${id}`).expect(204); // idempotent
    const after = await bearer(f, "get", "/api/library/", value);
    expect(after.status).toBe(401);
    expect(after.body).toEqual({ detail: "Invalid token" });
    expect((await f.asBob.get("/api/auth/tokens").expect(200)).body[0]).toMatchObject({ id, state: "revoked" });
  });

  it("caps active tokens at 25 (409)", async () => {
    const f = await setup();
    const tokens = f.h.app.get(TokenService);
    for (let i = 0; i < MAX_ACTIVE_TOKENS; i++) {
      await tokens.create({ memberId: f.bob.id, householdId: f.bob.householdId }, { name: `t${i}`, scopes: ["upload"], expiresInDays: 1 });
    }
    await f.asBob.post("/api/auth/tokens").send({ name: "one more", scopes: ["upload"], expires_in_days: 1 }).expect(409);
  });

  it("answers another member's token id with 404 and leaves the token working", async () => {
    const f = await setup();
    const { id, value } = await createToken(f.asBob);
    await f.asCarol.delete(`/api/auth/tokens/${id}`).expect(404);
    await f.asAlice.delete(`/api/auth/tokens/${id}`).expect(404);
    await f.asBob.delete("/api/auth/tokens/9999").expect(404);
    await bearer(f, "get", "/api/library/", value).expect(200);
  });

  it("refuses a token on the token routes with 403 session_required", async () => {
    const f = await setup();
    const { id, value } = await createToken(f.asBob, { scopes: ["documents:read", "upload", "settings:read"] });
    for (const [method, url] of [
      ["get", "/api/auth/tokens"],
      ["post", "/api/auth/tokens"],
      ["delete", `/api/auth/tokens/${id}`],
      ["get", "/api/events/counts"],
      ["get", "/api/auth/sessions"],
    ] as const) {
      const response = await bearer(f, method, url, value).send({ name: "t", scopes: ["upload"], expires_in_days: 1 });
      expect([url, response.status, response.body]).toEqual([url, 403, { detail: "session_required" }]);
    }
    expect(await f.h.db.select().from(personalAccessTokens)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Using a token (D3, D4, D5)
// ---------------------------------------------------------------------------

describe("bearer authentication with a token", () => {
  it("reads as its member: own documents yes, someone else's 404", async () => {
    const f = await setup();
    const { value } = await createToken(f.asBob, { scopes: ["documents:read"] });
    const library = await bearer(f, "get", "/api/library/", value).expect(200);
    expect(library.body.results.map((r: { id: number }) => r.id)).toEqual([2]);
    await bearer(f, "get", "/api/documents/2/detail", value).expect(200);
    await bearer(f, "get", "/api/documents/1/detail", value).expect(404);
  });

  it("uploads as its member", async () => {
    const f = await setup();
    const { value } = await createToken(f.asBob, { scopes: ["upload"] });
    await bearer(f, "post", "/api/documents/upload", value)
      .attach("files", Buffer.from("%PDF-1.4 scanner"), { filename: "scan.pdf", contentType: "application/pdf" })
      .expect(200);
    expect(f.paperless.uploads.at(-1)?.owner).toBe(await f.paperlessUser(f.bob.id));
  });

  it("refuses an action the token's scopes don't cover with 403 and changes nothing", async () => {
    const f = await setup();
    const { value } = await createToken(f.asBob, { scopes: ["documents:read"] });
    const response = await bearer(f, "delete", "/api/documents/2", value);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ detail: "Insufficient scope" });
    // Through UserOrInternalGuard too: authenticated as the member, then refused by scope.
    await bearer(f, "patch", "/api/documents/2/type-fields", value).send({}).expect(403);
    await bearer(f, "get", "/api/documents/2/detail", value).expect(200);
  });

  it("tells a script who it is on /auth/me", async () => {
    const f = await setup();
    const { value } = await createToken(f.asBob, { name: "Heimautomation" });
    const me = await bearer(f, "get", "/api/auth/me", value).expect(200);
    expect(me.body).toEqual({
      username: "bob",
      household_role: "member",
      enrolment_required: false,
      auth_method: "token",
      token_name: "Heimautomation",
    });
  });

  it("judges a bearer header alone: revoked, expired, unknown or malformed + a valid cookie → 401", async () => {
    const f = await setup();
    const { id: revokedId, value: revoked } = await createToken(f.asBob, { name: "revoked" });
    const { id: expiredId, value: expired } = await createToken(f.asBob, { name: "expired" });
    await f.asBob.delete(`/api/auth/tokens/${revokedId}`).expect(204);
    await f.h.db.update(personalAccessTokens).set({ expiresAt: ago("1 second") }).where(eq(personalAccessTokens.id, expiredId));

    await f.asBob.get("/api/library/").expect(200); // the cookie alone works
    for (const header of [
      `Bearer ${revoked}`,
      `Bearer ${expired}`,
      `Bearer akt_pat_${"A".repeat(43)}`,
      "Bearer akt_pat_short",
      "Bearer something-else",
      "Basic Ym9iOnBhc3N3b3Jk",
      "",
    ]) {
      const response = await f.asBob.get("/api/library/").set("Authorization", header);
      expect([header, response.status]).toEqual([header, 401]);
    }
  });

  it("is never accepted on the worker-only routes", async () => {
    const f = await setup();
    const { value } = await createToken(f.asAlice, { scopes: ["settings:read"] });
    const response = await bearer(f, "get", "/api/settings/active-llm-model", value);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ detail: "Invalid credential" });
  });

  it("records share reads through a token in the share-access audit", async () => {
    const f = await setup();
    await f.asAlice.post("/api/documents/1/shares").send({ member_id: f.bob.id, role: "viewer" }).expect(201);
    const { value } = await createToken(f.asBob, { scopes: ["documents:read"] });
    await bearer(f, "get", "/api/documents/1/detail", value).expect(200);
    const rows = await f.h.db
      .select()
      .from(shareAudit)
      .where(and(eq(shareAudit.memberId, f.bob.id), eq(shareAudit.event, "accessed")));
    expect(rows.map((r) => [r.paperlessDocId, r.accessKind])).toEqual([[1, "detail"]]);
  });

  it("records the last use (time and address) in the list", async () => {
    const f = await setup();
    const { id, value } = await createToken(f.asBob);
    await bearer(f, "get", "/api/library/", value, "203.0.113.9").expect(200);
    const [entry] = (await f.asBob.get("/api/auth/tokens").expect(200)).body as { id: number; last_used_at: string | null; last_used_ip: string | null }[];
    expect(entry).toMatchObject({ id, last_used_ip: "203.0.113.9" });
    expect(entry?.last_used_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Throttling and audit (D7)
// ---------------------------------------------------------------------------

describe("token throttling and audit", () => {
  it("throttles an address after 10 invalid tokens, even for a valid one; other addresses are unaffected", async () => {
    const f = await setup();
    const { value } = await createToken(f.asBob);
    const bogus = `akt_pat_${"B".repeat(43)}`;
    for (let i = 0; i < 10; i++) {
      await bearer(f, "get", "/api/library/", bogus, "192.0.2.50").expect(401);
    }
    const eleventh = await bearer(f, "get", "/api/library/", bogus, "192.0.2.50");
    expect(eleventh.status).toBe(429);
    expect(Number(eleventh.headers["retry-after"])).toBeGreaterThan(0);
    const valid = await bearer(f, "get", "/api/library/", value, "192.0.2.50");
    expect(valid.status).toBe(429);
    await bearer(f, "get", "/api/library/", value, "192.0.2.51").expect(200);
    expect(await f.h.db.select().from(authRateLimitEvents).where(eq(authRateLimitEvents.key, "token:ip:192.0.2.50"))).toHaveLength(10);
  });

  it("audits created, revoked and expired-then-used without the value", async () => {
    const f = await setup();
    const { id, value } = await createToken(f.asBob, { name: "Backup" });
    const { id: expiredId, value: expired } = await createToken(f.asBob, { name: "Cron" });
    await f.asBob.delete(`/api/auth/tokens/${id}`).expect(204);
    await f.h.db.update(personalAccessTokens).set({ expiresAt: ago("1 second") }).where(eq(personalAccessTokens.id, expiredId));
    await bearer(f, "get", "/api/library/", expired).expect(401);
    await bearer(f, "get", "/api/library/", expired).expect(401); // the hourly throttle: still one row

    const rows = await f.h.db.select().from(credentialAudit).where(eq(credentialAudit.memberId, f.bob.id));
    const tokenRows = rows.filter((r) => r.event.startsWith("token_"));
    expect(tokenRows.map((r) => r.event).sort()).toEqual(["token_created", "token_created", "token_rejected_expired", "token_revoked"]);
    expect(tokenRows.find((r) => r.event === "token_revoked")).toMatchObject({ actorMemberId: f.bob.id, detail: `${value.slice(0, DISPLAY_PREFIX_LENGTH)} Backup` });
    expect(tokenRows.find((r) => r.event === "token_rejected_expired")?.detail).toBe(`${expired.slice(0, DISPLAY_PREFIX_LENGTH)} Cron`);
    for (const row of tokenRows) {
      const dump = JSON.stringify(row);
      for (const secret of [value, expired]) expect(dump).not.toContain(secret.slice(DISPLAY_PREFIX_LENGTH));
      expect((dump.match(/akt_pat_\w*/g) ?? []).every((m) => m.length <= DISPLAY_PREFIX_LENGTH)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Member removal and sweep (D9)
// ---------------------------------------------------------------------------

describe("token revocation on member removal, and the sweep", () => {
  it("revokes every token of a removed member", async () => {
    const f = await setup();
    const { value } = await createToken(f.asBob);
    await createToken(f.asBob, { name: "second" });
    await bearer(f, "get", "/api/library/", value).expect(200);

    await f.asAlice.post(`/api/household/members/${f.bob.id}/remove`).send({ confirm_username: "bob" }).expect(200);
    await bearer(f, "get", "/api/library/", value).expect(401);
    const rows = await f.h.db.select().from(personalAccessTokens).where(eq(personalAccessTokens.memberId, f.bob.id));
    expect(rows.map((r) => [r.revokedReason, r.revokedByMemberId])).toEqual([
      ["member_removed", f.alice.id],
      ["member_removed", f.alice.id],
    ]);
    const audit = await f.h.db.select().from(credentialAudit).where(eq(credentialAudit.event, "token_revoked"));
    expect(audit.map((r) => r.actorMemberId)).toEqual([f.alice.id, f.alice.id]);
  });

  it("prunes tokens revoked or expired more than 30 days ago", async () => {
    const f = await setup();
    const tokens = f.h.app.get(TokenService);
    const make = async (name: string) =>
      (await tokens.create({ memberId: f.bob.id, householdId: f.bob.householdId }, { name, scopes: ["upload"], expiresInDays: 1 })).token.id;
    const revokedOld = await make("revoked-old");
    const expiredOld = await make("expired-old");
    const revokedRecent = await make("revoked-recent");
    await make("active");
    await f.h.db.update(personalAccessTokens).set({ revokedAt: ago("31 days") }).where(eq(personalAccessTokens.id, revokedOld));
    await f.h.db.update(personalAccessTokens).set({ expiresAt: ago("31 days") }).where(eq(personalAccessTokens.id, expiredOld));
    await f.h.db.update(personalAccessTokens).set({ revokedAt: ago("29 days") }).where(eq(personalAccessTokens.id, revokedRecent));

    expect(await f.h.app.get(AuthSweepService).sweep()).toMatchObject({ personal_access_tokens: 2 });
    const left = (await f.h.db.select().from(personalAccessTokens)).map((r) => r.name).sort();
    expect(left).toEqual(["active", "revoked-recent"]);
  });
});
