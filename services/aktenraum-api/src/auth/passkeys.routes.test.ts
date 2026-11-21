import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { ModulesContainer } from "@nestjs/core";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import {
  authAudit,
  authRateLimitEvents,
  credentialAudit,
  memberRemovals,
  passkeys,
  recoveryCodes,
  sessions,
  setupTokens,
  webauthnChallenges,
} from "../db/schema.js";
import { makeDoc } from "../test/fake-gateway.js";
import { household } from "../test/household.js";
import { ORIGIN, passkeyLogin, passwordLogin, registerPasskey, stepUp, type Agent } from "../test/passkey-helpers.js";
import { AAGUID_WINDOWS_HELLO, ExcludedCredentialError, SoftAuthenticator } from "../test/soft-authenticator.js";
import { ALLOW_RESTRICTED } from "./principal.js";
import { generateRecoveryCode, hashRecoveryCode, normaliseRecoveryCode } from "./recovery-codes.service.js";

type Fixture = Awaited<ReturnType<typeof household>>;
let fx: Fixture | null = null;

afterEach(async () => {
  await fx?.h.close();
  fx = null;
});

async function setup(options: { enrol?: boolean } = {}): Promise<Fixture> {
  fx = await household(undefined, undefined, options);
  return fx;
}

const server = (f: Fixture) => f.h.app.getHttpServer();
const authOf = (agent: { enrolled: { authenticator: SoftAuthenticator } | null }) => agent.enrolled!.authenticator;

/** Makes the session's last step-up older than 5 minutes. */
async function staleStepUp(f: Fixture, memberId: number): Promise<void> {
  await f.h.db
    .update(sessions)
    .set({ stepUpAt: sql`now() - interval '6 minutes'` as unknown as string })
    .where(eq(sessions.memberId, memberId));
}

function loginBegin(f: Fixture, ip?: string) {
  const r = request(server(f)).post("/api/auth/passkeys/login/begin").set("Origin", ORIGIN);
  if (ip) r.set("X-Forwarded-For", ip);
  return r.send({});
}

function loginFinish(f: Fixture, body: unknown, ip?: string) {
  const r = request(server(f)).post("/api/auth/passkeys/login/finish").set("Origin", ORIGIN);
  if (ip) r.set("X-Forwarded-For", ip);
  return r.send(body as object);
}

// ---------------------------------------------------------------------------

describe("addresses (WEBAUTHN_ORIGINS)", { timeout: 30_000 }, () => {
  it("publishes the configured origins without a session", async () => {
    const f = await setup({ enrol: false });
    expect((await request(server(f)).get("/api/auth/webauthn").expect(200)).body).toEqual({
      origins: ["http://localhost:8080", "http://localhost:4300"],
    });
  });

  it("refuses an unconfigured or missing Origin with 400 before any challenge exists", async () => {
    const f = await setup({ enrol: false });
    for (const origin of ["http://192.168.1.5:8080", "http://evil.example", null]) {
      const r = request(server(f)).post("/api/auth/passkeys/login/begin");
      if (origin) r.set("Origin", origin);
      await r.send({}).expect(400);
    }
    await f.asBob.post("/api/auth/passkeys/register/begin").set("Origin", "http://127.0.0.1:8080").send({}).expect(400);
    expect(await f.h.db.select().from(webauthnChallenges)).toEqual([]);
  });
});

describe("passkey sign-in", { timeout: 30_000 }, () => {
  it("signs a member in without a username, as a full session with a fresh step-up", async () => {
    const f = await setup();
    const agent = await passkeyLogin(f.h.app, authOf(f.asBob));
    expect((await agent.get("/api/auth/me").expect(200)).body).toEqual({
      username: "bob",
      household_role: "member",
      enrolment_required: false,
      auth_method: "passkey",
    });
    await agent.get("/api/library/").expect(200);
    const rows = (await f.h.db.select().from(sessions)).filter((s) => s.memberId === f.bob.id && s.authMethod === "passkey");
    expect(rows.every((row) => row.stepUpAt !== null)).toBe(true);
    const audit = await f.h.db.select().from(authAudit).where(eq(authAudit.event, "login_succeeded"));
    expect(audit.some((row) => row.memberId === f.bob.id && row.reason === "passkey")).toBe(true);
  });

  it("uses a ceremony once: a replay and an expired ceremony are 401", async () => {
    const f = await setup();
    const begin = await loginBegin(f).expect(200);
    const response = authOf(f.asBob).authenticate(begin.body.options);
    await loginFinish(f, { ceremony: begin.body.ceremony, response }).expect(200);
    await loginFinish(f, { ceremony: begin.body.ceremony, response }).expect(401);

    const late = await loginBegin(f).expect(200);
    await f.h.db.execute(sql`UPDATE webauthn_challenges SET expires_at = now() - interval '1 second'`);
    await loginFinish(f, { ceremony: late.body.ceremony, response: authOf(f.asBob).authenticate(late.body.options) }).expect(401);
  });

  it("answers unknown, removed and removed-member passkeys with the same 401", async () => {
    const f = await setup();
    const bodies: unknown[] = [];
    // Unknown: a credential the server never saw.
    const stranger = new SoftAuthenticator();
    stranger.register({ rp: { id: "localhost", name: "x" }, user: { id: "AAAA", name: "x", displayName: "x" }, challenge: "AAAA", pubKeyCredParams: [] });
    let begin = await loginBegin(f).expect(200);
    bodies.push((await loginFinish(f, { ceremony: begin.body.ceremony, response: stranger.authenticate(begin.body.options) }).expect(401)).body);

    // Removed passkey.
    await f.h.db.update(passkeys).set({ removedAt: sql`now()` as unknown as string }).where(eq(passkeys.memberId, f.carol.id));
    begin = await loginBegin(f).expect(200);
    bodies.push((await loginFinish(f, { ceremony: begin.body.ceremony, response: authOf(f.asCarol).authenticate(begin.body.options) }).expect(401)).body);

    // Removed member.
    await f.h.db.insert(memberRemovals).values({ memberId: f.bob.id, successorId: f.alice.id, removedBy: f.alice.id });
    begin = await loginBegin(f).expect(200);
    bodies.push((await loginFinish(f, { ceremony: begin.body.ceremony, response: authOf(f.asBob).authenticate(begin.body.options) }).expect(401)).body);

    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toEqual({ detail: "Passkey nicht akzeptiert" });
  });

  it("refuses a wrong user handle and a counter that goes backwards", async () => {
    const f = await setup();
    let begin = await loginBegin(f).expect(200);
    await loginFinish(f, {
      ceremony: begin.body.ceremony,
      response: authOf(f.asBob).authenticate(begin.body.options, { userHandle: "c29tZW9uZS1lbHNl" }),
    }).expect(401);

    await f.h.db.update(passkeys).set({ signCount: 100 }).where(eq(passkeys.memberId, f.bob.id));
    begin = await loginBegin(f).expect(200);
    await loginFinish(f, { ceremony: begin.body.ceremony, response: authOf(f.asBob).authenticate(begin.body.options) }).expect(401);
    const [row] = await f.h.db.select().from(passkeys).where(eq(passkeys.memberId, f.bob.id));
    expect(row!.signCount).toBe(100);
  });

  it("limits failures per address (10 → 429 with Retry-After, also at begin) and audits them", async () => {
    const f = await setup();
    const ip = "203.0.113.44";
    for (let i = 0; i < 10; i += 1) {
      const begin = await loginBegin(f, ip).expect(200);
      await loginFinish(f, {
        ceremony: begin.body.ceremony,
        response: authOf(f.asBob).authenticate(begin.body.options, { badSignature: true }),
      }, ip).expect(401);
    }
    const throttled = await loginBegin(f, ip).expect(429);
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
    // Every login kind from that address is throttled.
    await request(server(f)).post("/api/auth/login").set("X-Forwarded-For", ip).send({ username: "x", password: "y" }).expect(429);
    await loginBegin(f, "198.51.100.1").expect(200);
    const failed = (await f.h.db.select().from(authAudit)).filter((row) => row.event === "login_failed" && row.reason === "passkey");
    expect(failed).toHaveLength(10);
    expect(failed[0]!.ip).toBe(ip);
  });
});

describe("restricted sessions (password before enrolment)", { timeout: 30_000 }, () => {
  it("allow only /me and enrolment; everything else is 403 enrolment_required", async () => {
    const f = await setup({ enrol: false });
    expect((await f.asBob.get("/api/auth/me").expect(200)).body).toMatchObject({ enrolment_required: true, auth_method: "password" });
    expect((await f.asBob.get("/api/library/").expect(403)).body).toEqual({ detail: "enrolment_required" });
    await f.asBob.get("/api/events/counts").expect(403);
    await f.asBob.get("/api/auth/sessions").expect(403);
  });

  it("refuses every guarded route except the allowed ones", { timeout: 60_000 }, async () => {
    const f = await setup({ enrol: false });
    const VERBS: Record<number, "get" | "post" | "put" | "delete" | "patch"> = { 0: "get", 1: "post", 2: "put", 3: "delete", 4: "patch" };
    const checked: string[] = [];
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
            ...((Reflect.getMetadata(GUARDS_METADATA, ctrl) as { name: string }[]) ?? []),
            ...((Reflect.getMetadata(GUARDS_METADATA, handler) as { name: string }[]) ?? []),
          ].map((g) => g.name);
          // Secret-only routes never see a session.
          if (!guards.some((g) => g === "AuthGuard" || g === "UserOrInternalGuard")) continue;
          if (Reflect.getMetadata(ALLOW_RESTRICTED, handler) === true) continue;
          const verb = VERBS[Reflect.getMetadata(METHOD_METADATA, handler) as number] ?? "get";
          const url = "/" + ["api", base, String(path).replace(/^\/|\/$/g, "")].filter(Boolean).join("/").replace(/:[a-z_]+/g, "1");
          const response = await (f.asBob as Agent)[verb](url).send({});
          expect([url, response.status, response.body.detail]).toEqual([url, 403, "enrolment_required"]);
          checked.push(`${verb} ${url}`);
        }
      }
    }
    expect(checked.length).toBeGreaterThan(60);
  });
});

describe("enrolment", { timeout: 30_000 }, () => {
  it("password → restricted → passkey: codes once, new cookie, old cookie and password dead", { timeout: 30_000 }, async () => {
    const f = await setup({ enrol: false });
    const raw = await request(server(f)).post("/api/auth/login").send({ username: "bob", password: "password-123" }).expect(200);
    const oldCookie = (raw.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("aktenraum_session="))!.split(";")[0]!;
    const agent = request.agent(server(f));
    agent.set("Cookie", oldCookie);
    await agent.get("/api/library/").expect(403);
    const enrolled = await registerPasskey(agent, new SoftAuthenticator(), { name: "Laptop" });
    expect(enrolled.recoveryCodes).toHaveLength(10);
    expect(enrolled.recoveryCodes![0]).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    // The fixture's own password session (asBob) and the raw one are both gone.
    await f.asBob.get("/api/auth/me").expect(401);
    await request(server(f)).get("/api/auth/me").set("Cookie", oldCookie).expect(401);
    const fresh = await passkeyLogin(f.h.app, enrolled.authenticator);
    await fresh.get("/api/library/").expect(200);

    // Correct old password: refused like a wrong one, and counted.
    const refused = await request(server(f)).post("/api/auth/login").send({ username: "bob", password: "password-123" }).expect(401);
    expect(refused.body).toEqual({ detail: "Invalid credentials" });
    const keys = (await f.h.db.select().from(authRateLimitEvents)).map((r) => r.key);
    expect(keys).toContain("login:user:bob");

    const events = (await f.h.db.select().from(credentialAudit)).filter((r) => r.memberId === f.bob.id).map((r) => r.event);
    expect(events).toEqual(expect.arrayContaining(["passkey_added", "recovery_codes_generated", "password_retired"]));
    const [stored] = await f.h.db.select().from(passkeys).where(eq(passkeys.memberId, f.bob.id));
    expect(stored).toMatchObject({ name: "Laptop", rpId: "localhost", deviceType: "multiDevice" });
    // Codes are stored hashed only.
    const dump = JSON.stringify(await f.h.db.select().from(recoveryCodes));
    for (const code of enrolled.recoveryCodes!) expect(dump).not.toContain(normaliseRecoveryCode(code));
  });

  it("a member who leaves without enrolling keeps their password", async () => {
    const f = await setup({ enrol: false });
    await f.asBob.post("/api/auth/passkeys/register/begin").set("Origin", ORIGIN).send({}).expect(200);
    await passwordLogin(f.h.app, "bob", "password-123");
  });
});

describe("step-up", { timeout: 30_000 }, () => {
  it("empty trash: refused without a fresh confirmation, allowed after one, refused again once stale", { timeout: 30_000 }, async () => {
    const f = await setup();
    f.paperless.trashed.set(9, makeDoc({ id: 9 }));
    await staleStepUp(f, f.alice.id);
    expect((await f.asAlice.post("/api/trash/empty").expect(403)).body).toEqual({ detail: "step_up_required" });
    expect(f.paperless.emptyTrashCalls).toEqual([]);

    await stepUp(f.asAlice, authOf(f.asAlice));
    await f.asAlice.post("/api/trash/empty").expect(200);

    await staleStepUp(f, f.alice.id);
    await f.asAlice.post("/api/trash/empty").expect(403);
    const audit = (await f.h.db.select().from(credentialAudit)).filter((r) => r.event === "step_up_succeeded");
    expect(audit).toEqual([expect.objectContaining({ memberId: f.alice.id })]);
  });

  it("right after a passkey sign-in no further confirmation is asked", async () => {
    const f = await setup();
    const agent = await passkeyLogin(f.h.app, authOf(f.asAlice));
    await agent.post("/api/trash/empty").expect(200);
  });

  it("ordinary actions never ask", async () => {
    const f = await setup();
    await staleStepUp(f, f.bob.id);
    await f.asBob.get("/api/library/").expect(200);
    await f.asBob.post("/api/documents/2/star").expect((res) => expect(res.status).not.toBe(403));
  });

  it("refuses another member's passkey, counts it on the address and audits it", async () => {
    const f = await setup();
    await staleStepUp(f, f.bob.id);
    const begin = await f.asBob.post("/api/auth/step-up/begin").set("Origin", ORIGIN).send({}).expect(200);
    const carols = authOf(f.asCarol);
    const response = carols.authenticate(begin.body.options, { credential: carols.credentials[0] });
    await f.asBob
      .post("/api/auth/step-up/finish")
      .set("Origin", ORIGIN)
      .send({ ceremony: begin.body.ceremony, response })
      .expect(401);
    await f.asBob.post("/api/auth/recovery-codes").expect(403);
    const keys = (await f.h.db.select().from(authRateLimitEvents)).map((r) => r.key);
    expect(keys.filter((k) => k.startsWith("login:ip:"))).toHaveLength(1);
    const failed = (await f.h.db.select().from(credentialAudit)).filter((r) => r.event === "step_up_failed");
    expect(failed).toEqual([expect.objectContaining({ memberId: f.bob.id })]);
  });
});

describe("passkey management", { timeout: 30_000 }, () => {
  it("lists, adds (step-up), renames and removes own passkeys; never the last one", { timeout: 30_000 }, async () => {
    const f = await setup();
    await passkeyLogin(f.h.app, authOf(f.asBob)); // sets last use
    const second = await registerPasskey(f.asBob, new SoftAuthenticator({ aaguid: AAGUID_WINDOWS_HELLO, synced: false }));
    expect(second.recoveryCodes).toBeNull();
    const list = (await f.asBob.get("/api/auth/passkeys").expect(200)).body as Record<string, unknown>[];
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ provider: "Google Passwortmanager", synced: true, rp_id: "localhost", prf: false });
    expect(list[0]!.last_used_at).not.toBeNull();
    expect(list[1]).toMatchObject({ provider: "Windows Hello", synced: false, rp_id: "localhost", last_used_at: null });

    const renamed = await f.asBob.patch(`/api/auth/passkeys/${second.passkeyId}`).send({ name: "Büro-PC" }).expect(200);
    expect(renamed.body.name).toBe("Büro-PC");
    await f.asBob.delete(`/api/auth/passkeys/${second.passkeyId}`).expect(204);
    await f.asBob.delete(`/api/auth/passkeys/${list[0]!.id}`).expect(409);
    // The removed one no longer signs in.
    await passkeyLogin(f.h.app, second.authenticator, 401);
    const events = (await f.h.db.select().from(credentialAudit)).filter((r) => r.memberId === f.bob.id).map((r) => r.event);
    expect(events).toEqual(expect.arrayContaining(["passkey_added", "passkey_renamed", "passkey_removed"]));
  });

  it("answers 404 for another member's passkey and changes nothing", async () => {
    const f = await setup();
    const [carols] = await f.h.db.select().from(passkeys).where(eq(passkeys.memberId, f.carol.id));
    await f.asBob.patch(`/api/auth/passkeys/${carols!.id}`).send({ name: "mine" }).expect(404);
    await f.asBob.delete(`/api/auth/passkeys/${carols!.id}`).expect(404);
    expect((await f.h.db.select().from(passkeys).where(eq(passkeys.id, carols!.id)))[0]).toMatchObject({ removedAt: null });
  });

  it("adding needs a step-up; the same authenticator is excluded", async () => {
    const f = await setup();
    // Same authenticator again: listed in excludeCredentials, the browser refuses.
    const begin = await f.asBob.post("/api/auth/passkeys/register/begin").set("Origin", ORIGIN).send({}).expect(200);
    expect(begin.body.options.excludeCredentials).toHaveLength(1);
    expect(() => authOf(f.asBob).register(begin.body.options)).toThrow(ExcludedCredentialError);

    await staleStepUp(f, f.bob.id);
    expect((await f.asBob.post("/api/auth/passkeys/register/begin").set("Origin", ORIGIN).send({}).expect(403)).body).toEqual({
      detail: "step_up_required",
    });
    await f.asBob.patch("/api/auth/passkeys/1").send({ name: "x" }).expect(403);
  });
});

describe("recovery codes", { timeout: 30_000 }, () => {
  it("formats and normalises codes", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(normaliseRecoveryCode(" ab0o-il1x yz ")).toBe("AB00111XYZ");
    expect(hashRecoveryCode(code.toLowerCase().replace(/-/g, " "))).toBe(hashRecoveryCode(code));
  });

  it("a code signs in restricted, enrolment gives a full session; the code is used up", { timeout: 30_000 }, async () => {
    const f = await setup();
    const code = f.asBob.enrolled!.recoveryCodes![0]!;
    const agent = request.agent(server(f));
    const login = await agent.post("/api/auth/recovery").send({ username: "bob", code: code.toLowerCase() }).expect(200);
    expect(login.body).toEqual({ username: "bob", enrolment_required: true });
    expect((await agent.get("/api/library/").expect(403)).body.detail).toBe("enrolment_required");
    const enrolled = await registerPasskey(agent);
    expect(enrolled.recoveryCodes).toBeNull(); // 9 unused codes left
    await agent.get("/api/library/").expect(200);
    await request(server(f)).post("/api/auth/recovery").send({ username: "bob", code }).expect(401);
    expect((await agent.get("/api/auth/recovery-codes").expect(200)).body).toEqual({ remaining: 9 });
    // The recovery session itself was ended by the enrolment.
    const recovery = (await f.h.db.select().from(sessions)).filter((s) => s.authMethod === "recovery");
    expect(recovery.map((s) => s.revokedReason)).toEqual(["user"]);
    const used = (await f.h.db.select().from(credentialAudit)).filter((r) => r.event === "recovery_code_used");
    expect(used).toEqual([expect.objectContaining({ memberId: f.bob.id })]);
  });

  it("regenerating (step-up) invalidates the old set", async () => {
    const f = await setup();
    const old = f.asBob.enrolled!.recoveryCodes![0]!;
    const fresh = (await f.asBob.post("/api/auth/recovery-codes").expect(200)).body.codes as string[];
    expect(fresh).toHaveLength(10);
    await request(server(f)).post("/api/auth/recovery").send({ username: "bob", code: old }).expect(401);
    await request(server(f)).post("/api/auth/recovery").send({ username: "bob", code: fresh[0] }).expect(200);
    await staleStepUp(f, f.bob.id);
    await f.asBob.post("/api/auth/recovery-codes").expect(403);
  });

  it("wrong codes count per username (10 → 429); an unknown username answers like a wrong code", async () => {
    const f = await setup();
    const unknown = await request(server(f)).post("/api/auth/recovery").send({ username: "nobody", code: "AAAA-BBBB-CCCC-DDDD" }).expect(401);
    const wrong = await request(server(f)).post("/api/auth/recovery").send({ username: "bob", code: "AAAA-BBBB-CCCC-DDDD" }).expect(401);
    expect(unknown.body).toEqual(wrong.body);
    for (let i = 0; i < 9; i += 1) {
      await request(server(f))
        .post("/api/auth/recovery")
        .set("X-Forwarded-For", `198.51.100.${i + 1}`)
        .send({ username: "bob", code: "AAAA-BBBB-CCCC-DDDD" })
        .expect(401);
    }
    await request(server(f))
      .post("/api/auth/recovery")
      .set("X-Forwarded-For", "203.0.113.9")
      .send({ username: "bob", code: f.asBob.enrolled!.recoveryCodes![0] })
      .expect(429);
  });
});

describe("setup links", { timeout: 30_000 }, () => {
  async function issue(f: Fixture, memberId: number) {
    return (await f.asAlice.post(`/api/household/members/${memberId}/setup-link`).expect(201)).body as { token: string; expires_at: string };
  }

  async function useLink(f: Fixture, token: string, authenticator = new SoftAuthenticator()) {
    const agent = request.agent(server(f));
    const begin = await agent.post(`/api/setup/${token}/register/begin`).set("Origin", ORIGIN).send({}).expect(200);
    const finish = await agent
      .post(`/api/setup/${token}/register/finish`)
      .set("Origin", ORIGIN)
      .send({ ceremony: begin.body.ceremony, response: authenticator.register(begin.body.options) })
      .expect(200);
    return { agent, finish };
  }

  it("the admin issues one; the member enrols with it and gets a full session and a new code set", { timeout: 30_000 }, async () => {
    const f = await setup();
    const link = await issue(f, f.bob.id);
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // One clock: pg-mem's now() is offset from Date.now() by the local UTC offset.
    const [row] = await f.h.db.select().from(setupTokens);
    expect((Date.parse(row!.expiresAt) - Date.parse(row!.createdAt)) / 60_000).toBeCloseTo(30, 3);
    expect((await request(server(f)).get(`/api/setup/${link.token}`).expect(200)).body).toMatchObject({ username: "bob" });

    const { agent, finish } = await useLink(f, link.token);
    expect(finish.body.recovery_codes).toHaveLength(10);
    expect((await agent.get("/api/auth/me").expect(200)).body).toMatchObject({ username: "bob", auth_method: "setup", enrolment_required: false });
    await agent.get("/api/library/").expect(200);
    // Old codes are dead, the link is used up.
    await request(server(f)).post("/api/auth/recovery").send({ username: "bob", code: f.asBob.enrolled!.recoveryCodes![0] }).expect(401);
    await request(server(f)).get(`/api/setup/${link.token}`).expect(404);
    // Other sessions stay (the member decides on the device list).
    await f.asBob.get("/api/auth/me").expect(200);

    const audit = await f.h.db.select().from(credentialAudit);
    expect(audit.find((r) => r.event === "setup_link_created")).toMatchObject({ memberId: f.bob.id, actorMemberId: f.alice.id });
    expect(audit.find((r) => r.event === "setup_link_used")).toMatchObject({ memberId: f.bob.id });
    expect(JSON.stringify(audit)).not.toContain(link.token);
    expect(JSON.stringify(await f.h.db.select().from(setupTokens))).not.toContain(link.token);
  });

  it("expired, used, revoked and removed-member links all answer the same 404", { timeout: 30_000 }, async () => {
    const f = await setup();
    const answers: string[] = [];
    const expired = await issue(f, f.carol.id);
    await f.h.db.execute(sql`UPDATE setup_tokens SET expires_at = now() - interval '1 minute'`);
    answers.push(JSON.stringify((await request(server(f)).get(`/api/setup/${expired.token}`).expect(404)).body));

    const revoked = await issue(f, f.bob.id);
    const current = await issue(f, f.bob.id); // revokes the earlier one
    answers.push(JSON.stringify((await request(server(f)).get(`/api/setup/${revoked.token}`).expect(404)).body));

    await useLink(f, current.token);
    answers.push(JSON.stringify((await request(server(f)).post(`/api/setup/${current.token}/register/begin`).set("Origin", ORIGIN).send({}).expect(404)).body));

    const removed = await issue(f, f.carol.id);
    await f.h.db.insert(memberRemovals).values({ memberId: f.carol.id, successorId: f.alice.id, removedBy: f.alice.id });
    answers.push(JSON.stringify((await request(server(f)).get(`/api/setup/${removed.token}`).expect(404)).body));
    answers.push(JSON.stringify((await request(server(f)).get("/api/setup/not-a-token").expect(404)).body));
    expect(new Set(answers).size).toBe(1);
  });

  it("only the household admin issues them, with a step-up", async () => {
    const f = await setup();
    await f.asBob.post(`/api/household/members/${f.carol.id}/setup-link`).expect(403);
    await f.asAlice.post("/api/household/members/9999/setup-link").expect(404);
    await staleStepUp(f, f.alice.id);
    expect((await f.asAlice.post(`/api/household/members/${f.bob.id}/setup-link`).expect(403)).body.detail).toBe("step_up_required");
  });

  it("limits link checks per address", async () => {
    const f = await setup();
    for (let i = 0; i < 10; i += 1) await request(server(f)).get(`/api/setup/guess-${i}`).set("X-Forwarded-For", "203.0.113.70").expect(404);
    await request(server(f)).get("/api/setup/guess-x").set("X-Forwarded-For", "203.0.113.70").expect(429);
    await request(server(f)).get("/api/setup/guess-x").set("X-Forwarded-For", "198.51.100.70").expect(404);
  });
});

describe("auth sweep (passkey tables)", { timeout: 30_000 }, () => {
  it("prunes only old challenges, setup links, spent recovery codes and credential audit rows", async () => {
    const f = await setup();
    const back = (interval: string) => sql.raw(`now() - interval '${interval}'`) as unknown as string;
    await f.h.db.delete(webauthnChallenges);
    await f.h.db.insert(webauthnChallenges).values([
      { ceremony: "old", challenge: "c", kind: "login", purpose: "login", rpId: "localhost", origin: ORIGIN, expiresAt: back("25 hours") },
      { ceremony: "new", challenge: "c", kind: "login", purpose: "login", rpId: "localhost", origin: ORIGIN, expiresAt: back("23 hours") },
    ]);
    await f.h.db.insert(setupTokens).values([
      { tokenHash: "a".repeat(64), memberId: f.bob.id, expiresAt: back("31 days") },
      { tokenHash: "b".repeat(64), memberId: f.bob.id, expiresAt: back("29 days") },
    ]);
    await f.h.db.delete(recoveryCodes);
    // One insert per row: pg-mem mishandles multi-row inserts with mixed defaults.
    for (const row of [
      { memberId: f.bob.id, batchId: "x", codeHash: "1".repeat(64), usedAt: back("181 days") },
      { memberId: f.bob.id, batchId: "x", codeHash: "2".repeat(64), invalidatedAt: back("181 days") },
      { memberId: f.bob.id, batchId: "x", codeHash: "3".repeat(64), usedAt: back("179 days") },
      { memberId: f.bob.id, batchId: "x", codeHash: "4".repeat(64), createdAt: back("400 days") }, // unused: kept
    ]) {
      await f.h.db.insert(recoveryCodes).values(row);
    }
    await f.h.db.delete(credentialAudit);
    await f.h.db.insert(credentialAudit).values([
      { event: "passkey_added", detail: "old", at: back("181 days") },
      { event: "passkey_added", detail: "new", at: back("179 days") },
    ]);
    const { AuthSweepService } = await import("./auth-sweep.service.js");
    expect(await f.h.app.get(AuthSweepService).sweep()).toMatchObject({
      challenges: 1,
      setup_tokens: 1,
      recovery_codes: 2,
      credential_audit: 1,
    });
    expect((await f.h.db.select().from(webauthnChallenges)).map((r) => r.ceremony)).toEqual(["new"]);
    expect((await f.h.db.select().from(recoveryCodes)).map((r) => r.codeHash[0]).sort()).toEqual(["3", "4"]);
    expect((await f.h.db.select().from(credentialAudit)).map((r) => r.detail)).toEqual(["new"]);
  });
});
