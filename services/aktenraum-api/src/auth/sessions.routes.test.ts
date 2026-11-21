import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { authAudit, authRateLimitEvents, sessions } from "../db/schema.js";
import { createHarness, type Harness } from "../test/harness.js";
import { household } from "../test/household.js";
import { ORIGIN, joinWithInvite } from "../test/passkey-helpers.js";
import { SoftAuthenticator } from "../test/soft-authenticator.js";
import { AuthSweepService } from "./auth-sweep.service.js";
import { hashSessionToken } from "./session.service.js";

type Fixture = Awaited<ReturnType<typeof household>>;

let fx: Fixture | null = null;
const extra: Harness[] = [];

afterEach(async () => {
  for (const h of extra.splice(0)) await h.close();
  await fx?.h.close();
  fx = null;
});

async function setup(env?: Record<string, string>, options?: { enrol?: boolean }): Promise<Fixture> {
  fx = await household(undefined, env, options);
  return fx;
}

function authenticatorOf(f: Fixture, username: string): SoftAuthenticator {
  const agent = { alice: f.asAlice, bob: f.asBob, carol: f.asCarol }[username];
  if (agent?.enrolled == null) throw new Error(`${username} has no passkey`);
  return agent.enrolled.authenticator;
}

const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";

function cookieValue(setCookie: string[] | undefined, name: string): string | null {
  const entry = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  if (entry === undefined) return null;
  const value = entry.slice(name.length + 1).split(";")[0] ?? "";
  return value === "" ? null : decodeURIComponent(value);
}

/** A fresh device: its own agent (cookie jar), address and user agent; signs in with the member's passkey. */
async function device(
  f: Fixture,
  username: string,
  options: { ip?: string; agent?: string } = {},
): Promise<{ agent: ReturnType<typeof request.agent>; token: string; response: request.Response }> {
  const agent = request.agent(f.h.app.getHttpServer());
  if (options.ip !== undefined) agent.set("X-Forwarded-For", options.ip);
  if (options.agent !== undefined) agent.set("User-Agent", options.agent);
  const begin = await agent.post("/api/auth/passkeys/login/begin").set("Origin", ORIGIN).send({}).expect(200);
  const response = await agent
    .post("/api/auth/passkeys/login/finish")
    .set("Origin", ORIGIN)
    .send({ ceremony: begin.body.ceremony, response: authenticatorOf(f, username).authenticate(begin.body.options) })
    .expect(200);
  const cookies = response.headers["set-cookie"] as unknown as string[];
  const token = cookieValue(cookies, "__Host-aktenraum_session") ?? cookieValue(cookies, "aktenraum_session");
  expect(token).not.toBeNull();
  return { agent, token: token!, response };
}

async function sessionRow(h: Harness, token: string) {
  const [row] = await h.db.select().from(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
  return row!;
}

function streamBody(test: request.Test): Promise<string> {
  return test
    .buffer(true)
    .parse((res, done) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => done(null, body));
    })
    .then((res) => res.body as string);
}

describe("sessions: issue and resolve", () => {
  it("stores only the token's hash, with the browser's address behind nginx and its user agent", async () => {
    const f = await setup();
    const { token } = await device(f, "bob", { ip: "203.0.113.7", agent: CHROME_WIN });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await sessionRow(f.h, token);
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toBe(hashSessionToken(token));
    expect(row.memberId).toBe(f.bob.id);
    expect(row.householdId).toBe(f.bob.householdId);
    expect(row.authMethod).toBe("passkey");
    expect(row.ip).toBe("203.0.113.7");
    expect(row.userAgent).toBe(CHROME_WIN);
    // Nothing stored works as a cookie.
    await request(f.h.app.getHttpServer())
      .get("/api/auth/me")
      .set("Cookie", `aktenraum_session=${row.tokenHash}`)
      .expect(401);
  });

  it("sets a __Host- Secure cookie on HTTPS deployments and clears the plain name", async () => {
    // An http test agent drops Secure cookies, so the cookie travels by hand:
    // password login (restricted) → enrol → the passkey session's cookie.
    const f = await setup({ COOKIE_SECURE: "true" }, { enrol: false });
    const server0 = f.h.app.getHttpServer();
    const login = await request(server0).post("/api/auth/login").send({ username: "bob", password: "password-123" }).expect(200);
    const restricted = cookieValue(login.headers["set-cookie"] as unknown as string[], "__Host-aktenraum_session")!;
    const begin = await request(server0)
      .post("/api/auth/passkeys/register/begin")
      .set("Cookie", `__Host-aktenraum_session=${restricted}`)
      .set("Origin", ORIGIN)
      .send({})
      .expect(200);
    const response = await request(server0)
      .post("/api/auth/passkeys/register/finish")
      .set("Cookie", `__Host-aktenraum_session=${restricted}`)
      .set("Origin", ORIGIN)
      .send({ ceremony: begin.body.ceremony, response: new SoftAuthenticator().register(begin.body.options) })
      .expect(200);
    const cookies = response.headers["set-cookie"] as unknown as string[];
    const session = cookies.find((c) => c.startsWith("__Host-aktenraum_session="))!;
    expect(session).toContain("Secure");
    expect(session).toContain("HttpOnly");
    expect(session).toContain("SameSite=Lax");
    expect(session).toContain("Path=/");
    expect(session).not.toContain("Domain");
    expect(session).toContain(`Max-Age=${30 * 24 * 3600}`); // SESSION_ABSOLUTE_DAYS
    expect(cookies.some((c) => c.startsWith("aktenraum_session=;"))).toBe(true);
    const token = cookieValue(cookies, "__Host-aktenraum_session")!;
    const server = f.h.app.getHttpServer();
    await request(server).get("/api/auth/me").set("Cookie", `__Host-aktenraum_session=${token}`).expect(200);
    // The plain name is not read on HTTPS deployments.
    await request(server).get("/api/auth/me").set("Cookie", `aktenraum_session=${token}`).expect(401);
  });

  it("sets a plain, non-Secure cookie when COOKIE_SECURE=false", async () => {
    const f = await setup();
    const { response } = await device(f, "bob");
    const session = (response.headers["set-cookie"] as unknown as string[]).find((c) =>
      c.startsWith("aktenraum_session="),
    )!;
    expect(session).toContain("HttpOnly");
    expect(session).not.toContain("Secure");
  });

  it("answers 401 for unknown, revoked, idle-expired and absolute-expired sessions", async () => {
    const f = await setup();
    const server = f.h.app.getHttpServer();
    await request(server).get("/api/auth/me").set("Cookie", "aktenraum_session=unknown-token").expect(401);

    const revoked = await device(f, "bob");
    await f.h.db
      .update(sessions)
      .set({ revokedAt: sql`now()` as unknown as string, revokedReason: "user" })
      .where(eq(sessions.tokenHash, hashSessionToken(revoked.token)));
    await revoked.agent.get("/api/auth/me").expect(401);

    const idle = await device(f, "bob");
    await f.h.db
      .update(sessions)
      .set({ idleExpiresAt: sql`now() - interval '1 minute'` as unknown as string })
      .where(eq(sessions.tokenHash, hashSessionToken(idle.token)));
    await idle.agent.get("/api/auth/me").expect(401);

    const absolute = await device(f, "bob");
    await f.h.db
      .update(sessions)
      .set({ absoluteExpiresAt: sql`now() - interval '1 minute'` as unknown as string })
      .where(eq(sessions.tokenHash, hashSessionToken(absolute.token)));
    await absolute.agent.get("/api/auth/me").expect(401);
  });

  it("slides the idle expiry at most once a minute and never past the absolute expiry", async () => {
    const f = await setup();
    const { agent, token } = await device(f, "bob");
    const fresh = await sessionRow(f.h, token);
    // Two requests within the first minute write nothing.
    await agent.get("/api/auth/me").expect(200);
    await agent.get("/api/auth/me").expect(200);
    expect(await sessionRow(f.h, token)).toEqual(fresh);

    // Last use two minutes ago, idle expiry soon: one request slides it.
    const where = eq(sessions.tokenHash, hashSessionToken(token));
    await f.h.db
      .update(sessions)
      .set({
        lastSeenAt: sql`now() - interval '2 minutes'` as unknown as string,
        idleExpiresAt: sql`now() + interval '1 hour'` as unknown as string,
      })
      .where(where);
    const stale = await sessionRow(f.h, token);
    await agent.get("/api/auth/me").expect(200);
    const touched = await sessionRow(f.h, token);
    expect(Date.parse(touched.lastSeenAt)).toBeGreaterThan(Date.parse(stale.lastSeenAt));
    expect(Date.parse(touched.idleExpiresAt)).toBeGreaterThan(Date.parse(stale.idleExpiresAt) + 6 * 24 * 3600_000);
    // The next request within the minute doesn't write again.
    await agent.get("/api/auth/me").expect(200);
    expect(await sessionRow(f.h, token)).toEqual(touched);

    // Near the maximum age: the idle expiry stops at the absolute one.
    await f.h.db
      .update(sessions)
      .set({
        lastSeenAt: sql`now() - interval '2 minutes'` as unknown as string,
        absoluteExpiresAt: sql`now() + interval '2 days'` as unknown as string,
      })
      .where(where);
    await agent.get("/api/auth/me").expect(200);
    const capped = await sessionRow(f.h, token);
    expect(capped.idleExpiresAt).toBe(capped.absoluteExpiresAt);
  });
});

describe("sessions: revocation", () => {
  it("logout revokes the session on the server; a replayed cookie answers 401", async () => {
    const f = await setup();
    const { agent, token } = await device(f, "bob");
    const response = await agent.post("/api/auth/logout").expect(204);
    expect((response.headers["set-cookie"] as unknown as string[]).some((c) => c.startsWith("aktenraum_session=;"))).toBe(
      true,
    );
    expect((await sessionRow(f.h, token)).revokedReason).toBe("logout");
    await request(f.h.app.getHttpServer()).get("/api/auth/me").set("Cookie", `aktenraum_session=${token}`).expect(401);
  });

  it("logout with an unknown or missing cookie is a no-op that still clears it", async () => {
    const f = await setup();
    const server = f.h.app.getHttpServer();
    await request(server).post("/api/auth/logout").set("Cookie", "aktenraum_session=nope").expect(204);
    await request(server).post("/api/auth/logout").expect(204);
    await f.asBob.get("/api/auth/me").expect(200);
  });

  it("enrolling revokes the member's password sessions, and the password stops working", { timeout: 30_000 }, async () => {
    const f = await setup(undefined, { enrol: false });
    const laptop = f.asBob;
    const phone = request.agent(f.h.app.getHttpServer());
    await phone.post("/api/auth/login").send({ username: "bob", password: "password-123" }).expect(200);
    // Enrol on the laptop: both restricted password sessions end, a passkey session replaces the laptop's.
    const begin = await laptop.post("/api/auth/passkeys/register/begin").set("Origin", ORIGIN).send({}).expect(200);
    await laptop
      .post("/api/auth/passkeys/register/finish")
      .set("Origin", ORIGIN)
      .send({ ceremony: begin.body.ceremony, response: new SoftAuthenticator().register(begin.body.options) })
      .expect(200);
    await laptop.get("/api/auth/sessions").expect(200);
    await phone.get("/api/auth/me").expect(401);
    const bobPassword = (await f.h.db.select().from(sessions)).filter(
      (row) => row.memberId === f.bob.id && row.authMethod === "password",
    );
    expect(bobPassword.map((row) => row.revokedReason)).toEqual(["password_change", "password_change"]);
    await f.asCarol.get("/api/auth/me").expect(200);
    await request(f.h.app.getHttpServer())
      .post("/api/auth/login")
      .send({ username: "bob", password: "password-123" })
      .expect(401);
  });
});

describe("sessions: device list", () => {
  it("lists the member's active sessions with the current one marked", async () => {
    const f = await setup();
    const laptop = await device(f, "bob", { ip: "203.0.113.7", agent: CHROME_WIN });
    const phone = await device(f, "bob", { ip: "198.51.100.23", agent: SAFARI_IOS });
    await f.asBob.post("/api/auth/logout").expect(204);
    const list = (await laptop.agent.get("/api/auth/sessions").expect(200)).body as {
      id: number;
      ip: string;
      user_agent: string;
      auth_method: string;
      current: boolean;
      created_at: string;
      last_seen_at: string;
    }[];
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    const current = list.find((s) => s.current)!;
    expect(current.id).toBe((await sessionRow(f.h, laptop.token)).id);
    expect(current).toMatchObject({ ip: "203.0.113.7", user_agent: CHROME_WIN, auth_method: "passkey" });
    expect(list.find((s) => !s.current)).toMatchObject({ ip: "198.51.100.23", user_agent: SAFARI_IOS });
    expect(Number.isNaN(Date.parse(current.created_at))).toBe(false);
    expect(Number.isNaN(Date.parse(current.last_seen_at))).toBe(false);
    void phone;
  });

  it("revokes another of the member's devices; the current one stays", async () => {
    const f = await setup();
    const laptop = await device(f, "bob");
    const phone = await device(f, "bob");
    const phoneId = (await sessionRow(f.h, phone.token)).id;
    const response = await laptop.agent.delete(`/api/auth/sessions/${phoneId}`).expect(204);
    expect(response.headers["set-cookie"]).toBeUndefined();
    await phone.agent.get("/api/auth/me").expect(401);
    await laptop.agent.get("/api/auth/me").expect(200);
    expect((await sessionRow(f.h, phone.token)).revokedReason).toBe("other_device");
  });

  it("answers 404 for another member's session and leaves it active", async () => {
    const f = await setup();
    const carol = await device(f, "carol");
    const carolId = (await sessionRow(f.h, carol.token)).id;
    await f.asBob.delete(`/api/auth/sessions/${carolId}`).expect(404);
    await f.asBob.delete("/api/auth/sessions/999999").expect(404);
    await carol.agent.get("/api/auth/me").expect(200);
    const listed = (await f.asBob.get("/api/auth/sessions").expect(200)).body as { id: number }[];
    expect(listed.map((s) => s.id)).not.toContain(carolId);
  });

  it("revoking the current session behaves like a logout", async () => {
    const f = await setup();
    const laptop = await device(f, "bob");
    const id = (await sessionRow(f.h, laptop.token)).id;
    const response = await laptop.agent.delete(`/api/auth/sessions/${id}`).expect(204);
    expect((response.headers["set-cookie"] as unknown as string[]).some((c) => c.startsWith("aktenraum_session=;"))).toBe(
      true,
    );
    expect((await sessionRow(f.h, laptop.token)).revokedReason).toBe("user");
    await request(f.h.app.getHttpServer())
      .get("/api/auth/me")
      .set("Cookie", `aktenraum_session=${laptop.token}`)
      .expect(401);
  });

  it("signs out all other devices and answers how many", async () => {
    const f = await setup();
    const laptop = await device(f, "bob");
    const phone = await device(f, "bob");
    const response = await laptop.agent.post("/api/auth/sessions/revoke-others").expect(200);
    // asBob (fixture login) + phone.
    expect(response.body).toEqual({ revoked: 2 });
    await phone.agent.get("/api/auth/me").expect(401);
    await f.asBob.get("/api/auth/me").expect(401);
    await laptop.agent.get("/api/auth/me").expect(200);
    await f.asCarol.get("/api/auth/me").expect(200);
    expect((await laptop.agent.post("/api/auth/sessions/revoke-others").expect(200)).body).toEqual({ revoked: 0 });
  });
});

describe("sessions: open live-counts streams", () => {
  it("ends with session_ended when the session is revoked from another device", { timeout: 20_000 }, async () => {
    const f = await setup();
    const phone = await device(f, "bob");
    const phoneId = (await sessionRow(f.h, phone.token)).id;
    const stream = streamBody(phone.agent.get("/api/events/counts"));
    await new Promise((resolve) => setTimeout(resolve, 500));
    await f.asBob.delete(`/api/auth/sessions/${phoneId}`).expect(204);
    const body = await stream;
    expect(body).toMatch(/^data: \{/m);
    expect(body).toContain("event: session_ended\ndata: revoked\n\n");
    await phone.agent.get("/api/events/counts").expect(401);
  });

  it("ends with session_ended when the session expires", { timeout: 20_000 }, async () => {
    const f = await setup();
    const phone = await device(f, "bob");
    const stream = streamBody(phone.agent.get("/api/events/counts"));
    await new Promise((resolve) => setTimeout(resolve, 500));
    await f.h.db
      .update(sessions)
      .set({ idleExpiresAt: sql`now() - interval '1 second'` as unknown as string })
      .where(eq(sessions.tokenHash, hashSessionToken(phone.token)));
    const body = await stream;
    expect(body).toContain("event: session_ended\ndata: expired\n\n");
  });
});

describe("login protection", () => {
  it("throttles a username after 10 failures, even with the right password", async () => {
    const f = await setup(undefined, { enrol: false });
    const server = f.h.app.getHttpServer();
    for (let i = 0; i < 10; i += 1) {
      // Different addresses: only the username key reaches the limit.
      await request(server)
        .post("/api/auth/login")
        .set("X-Forwarded-For", `198.51.100.${i + 1}`)
        .send({ username: "Bob", password: "wrong-password" })
        .expect(401);
    }
    const throttled = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "203.0.113.50")
      .send({ username: "bob", password: "password-123" })
      .expect(429);
    const retryAfter = Number(throttled.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThan(14 * 60);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
    // Carol from the same address is fine.
    await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "203.0.113.50")
      .send({ username: "carol", password: "password-123" })
      .expect(200);
  });

  it("throttles one address spraying many usernames; another address with a clean username logs in", async () => {
    const f = await setup(undefined, { enrol: false });
    const server = f.h.app.getHttpServer();
    for (let i = 0; i < 10; i += 1) {
      await request(server)
        .post("/api/auth/login")
        .set("X-Forwarded-For", "203.0.113.66")
        .send({ username: `user${i}`, password: "wrong-password" })
        .expect(401);
    }
    await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "203.0.113.66")
      .send({ username: "carol", password: "password-123" })
      .expect(429);
    await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "198.51.100.77")
      .send({ username: "carol", password: "password-123" })
      .expect(200);
  });

  it("a successful login resets the username's count but not the address's", async () => {
    const f = await setup(undefined, { enrol: false });
    const server = f.h.app.getHttpServer();
    const attempt = (username: string, password: string) =>
      request(server).post("/api/auth/login").set("X-Forwarded-For", "203.0.113.80").send({ username, password });
    for (let i = 0; i < 5; i += 1) await attempt("bob", "wrong-password").expect(401);
    await attempt("bob", "password-123").expect(200);
    const keys = (await f.h.db.select().from(authRateLimitEvents)).map((row) => row.key);
    expect(keys.filter((k) => k === "login:user:bob")).toHaveLength(0);
    expect(keys.filter((k) => k === "login:ip:203.0.113.80")).toHaveLength(5);
  });

  it("keeps counting across a restart of the api", async () => {
    const f = await setup(undefined, { enrol: false });
    for (let i = 0; i < 10; i += 1) {
      await request(f.h.app.getHttpServer())
        .post("/api/auth/login")
        .set("X-Forwarded-For", `198.51.100.${i + 1}`)
        .send({ username: "bob", password: "wrong-password" })
        .expect(401);
    }
    const restarted = await createHarness({ db: f.h.db });
    extra.push(restarted);
    await request(restarted.app.getHttpServer())
      .post("/api/auth/login")
      .send({ username: "bob", password: "password-123" })
      .expect(429);
  });

  it("throttles invite guessing per address", async () => {
    const f = await setup();
    const server = f.h.app.getHttpServer();
    for (let i = 0; i < 10; i += 1) {
      await request(server).get(`/api/invites/not-a-token-${i}`).set("X-Forwarded-For", "203.0.113.90").expect(404);
    }
    await request(server).get("/api/invites/not-a-token-x").set("X-Forwarded-For", "203.0.113.90").expect(429);
    await request(server).get("/api/invites/not-a-token-x").set("X-Forwarded-For", "198.51.100.90").expect(404);
  });
});

describe("auth audit", () => {
  it("records every event with member, session, address and user agent — and never a token or its hash", {
    timeout: 30_000,
  }, async () => {
    const f = await setup();
    const server = f.h.app.getHttpServer();
    const tokens: string[] = [];

    // Failed then successful login.
    await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "203.0.113.7")
      .set("User-Agent", CHROME_WIN)
      .send({ username: "Bob", password: "wrong-password" })
      .expect(401);
    const laptop = await device(f, "bob", { ip: "203.0.113.7", agent: CHROME_WIN });
    const phone = await device(f, "bob", { ip: "198.51.100.23", agent: SAFARI_IOS });
    tokens.push(laptop.token, phone.token);
    const laptopId = (await sessionRow(f.h, laptop.token)).id;
    const phoneId = (await sessionRow(f.h, phone.token)).id;

    // Sign out the other device, then log out.
    await laptop.agent.delete(`/api/auth/sessions/${phoneId}`).expect(204);
    await laptop.agent.post("/api/auth/logout").expect(204);

    // Invite redemption with a passkey.
    const { token: invite } = (await f.asAlice.post("/api/household/invites").expect(201)).body as { token: string };
    const redeemed = await joinWithInvite(f.h.app, invite, "dave", { ip: "192.0.2.10" });
    tokens.push(cookieValue(redeemed.response.headers["set-cookie"] as unknown as string[], "aktenraum_session")!);

    const rows = await f.h.db.select().from(authAudit);
    const of = (event: string) => rows.filter((row) => row.event === event);

    expect(of("login_failed")).toEqual([
      expect.objectContaining({ username: "bob", memberId: null, ip: "203.0.113.7", userAgent: CHROME_WIN }),
    ]);
    expect(of("login_succeeded")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ memberId: f.bob.id, sessionId: laptopId, reason: "passkey", ip: "203.0.113.7", userAgent: CHROME_WIN }),
        expect.objectContaining({ memberId: f.bob.id, sessionId: phoneId, reason: "passkey", ip: "198.51.100.23", userAgent: SAFARI_IOS }),
      ]),
    );
    expect(of("session_revoked")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: f.bob.id,
          actorMemberId: f.bob.id,
          sessionId: phoneId,
          reason: "other_device",
          ip: "203.0.113.7",
        }),
        // The fixture's enrolment ended bob's password session.
        expect.objectContaining({ memberId: f.bob.id, actorMemberId: f.bob.id, reason: "password_change" }),
      ]),
    );
    expect(of("logout")).toEqual([
      expect.objectContaining({ memberId: f.bob.id, sessionId: laptopId, ip: "203.0.113.7", userAgent: CHROME_WIN }),
    ]);
    expect(of("invite_redeemed")).toEqual([expect.objectContaining({ ip: "192.0.2.10" })]);
    expect(of("invite_redeemed")[0]!.memberId).not.toBeNull();
    expect(of("invite_redeemed")[0]!.sessionId).not.toBeNull();
    expect(of("password_changed")).toEqual([]);

    // No column of any auth table row other than sessions.token_hash ever
    // holds a cookie token or its hash.
    const secrets = tokens.flatMap((token) => [token, hashSessionToken(token)]);
    const dump = JSON.stringify([rows, await f.h.db.select().from(authRateLimitEvents)]);
    for (const secret of secrets) expect(dump).not.toContain(secret);
    const sessionRows = await f.h.db.select().from(sessions);
    const sessionDump = JSON.stringify(sessionRows.map(({ tokenHash: _hash, ...rest }) => rest));
    for (const secret of secrets) expect(sessionDump).not.toContain(secret);
  });

  it("records a throttled attempt", async () => {
    const f = await setup();
    const server = f.h.app.getHttpServer();
    for (let i = 0; i < 11; i += 1) {
      await request(server)
        .post("/api/auth/login")
        .set("X-Forwarded-For", "203.0.113.5")
        .send({ username: "mallory", password: "wrong-password" });
    }
    const throttled = await f.h.db.select().from(authAudit).where(eq(authAudit.event, "login_throttled"));
    expect(throttled).toEqual([expect.objectContaining({ username: "mallory", ip: "203.0.113.5" })]);
  });
});

describe("auth sweep", () => {
  it("prunes only old sessions, rate-limit events and audit rows", async () => {
    const f = await setup();
    const sweep = f.h.app.get(AuthSweepService);
    const back = (interval: string) => sql.raw(`now() - interval '${interval}'`) as unknown as string;

    const keep = await device(f, "bob");
    const revokedLongAgo = await device(f, "bob");
    const revokedRecently = await device(f, "bob");
    const expiredLongAgo = await device(f, "bob");
    const byToken = (token: string) => eq(sessions.tokenHash, hashSessionToken(token));
    await f.h.db.update(sessions).set({ revokedAt: back("31 days"), revokedReason: "logout" }).where(byToken(revokedLongAgo.token));
    await f.h.db.update(sessions).set({ revokedAt: back("29 days"), revokedReason: "logout" }).where(byToken(revokedRecently.token));
    await f.h.db
      .update(sessions)
      .set({ idleExpiresAt: back("31 days"), absoluteExpiresAt: back("20 days") })
      .where(byToken(expiredLongAgo.token));

    await f.h.db.delete(authRateLimitEvents);
    await f.h.db.insert(authRateLimitEvents).values([
      { key: "login:user:old", at: back("25 hours") },
      { key: "login:user:new", at: back("23 hours") },
    ]);
    await f.h.db.delete(authAudit);
    await f.h.db.insert(authAudit).values([
      { event: "logout", reason: "old", at: back("181 days") },
      { event: "logout", reason: "new", at: back("179 days") },
    ]);

    expect(await sweep.sweep()).toEqual({
      sessions: 2,
      rate_limit_events: 1,
      audit: 1,
      challenges: 0,
      setup_tokens: 0,
      recovery_codes: 0,
      credential_audit: 0,
    });

    const left = await f.h.db.select().from(sessions);
    const leftHashes = left.map((row) => row.tokenHash);
    expect(leftHashes).toContain(hashSessionToken(keep.token));
    expect(leftHashes).toContain(hashSessionToken(revokedRecently.token));
    expect(leftHashes).not.toContain(hashSessionToken(revokedLongAgo.token));
    expect(leftHashes).not.toContain(hashSessionToken(expiredLongAgo.token));
    expect((await f.h.db.select().from(authRateLimitEvents)).map((row) => row.key)).toEqual(["login:user:new"]);
    expect((await f.h.db.select().from(authAudit)).map((row) => row.reason)).toEqual(["new"]);
  });
});
