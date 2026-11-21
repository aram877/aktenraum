import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { verifyPassword } from "../auth/passwords.js";
import {
  authRateLimitEvents,
  invites,
  memberPaperlessTokens,
  members,
  passkeys,
  passwordRetirements,
  recoveryCodes,
  spaces,
  users,
} from "../db/schema.js";
import type { PaperlessGateway } from "../paperless/paperless.gateway.js";
import { FakeGateway, TAGS, makeDoc } from "../test/fake-gateway.js";
import { createHarness, type Harness } from "../test/harness.js";
import { ORIGIN, joinWithInvite, registerPasskey } from "../test/passkey-helpers.js";
import { SoftAuthenticator } from "../test/soft-authenticator.js";

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function setup() {
  const paperless = new FakeGateway({
    docs: [makeDoc({ id: 1, tags: [TAGS["ai-propagated"] as number] })],
  });
  harness = await createHarness({
    gateway: paperless as unknown as Partial<PaperlessGateway>,
    env: { BOOTSTRAP_USERNAME: "admin", BOOTSTRAP_PASSWORD: "correct-horse" },
  });
  const h = harness;
  const server = h.app.getHttpServer();
  const admin = request.agent(server);
  await admin.post("/api/auth/login").send({ username: "admin", password: "correct-horse" }).expect(200);
  await registerPasskey(admin);
  const createInvite = async () => (await admin.post("/api/household/invites").expect(201)).body as {
    id: number;
    token: string;
    expires_at: string;
  };
  return { h, server, admin, paperless, createInvite };
}

/** begin → (optionally) finish, raw — for the non-happy paths. */
function beginInvite(server: unknown, token: string, username: string) {
  return request(server as never).post(`/api/invites/${token}/register/begin`).set("Origin", ORIGIN).send({ username });
}

describe("household invites (admin)", { timeout: 30_000 }, () => {
  it("creates a single-use link valid for 7 days and lists it as pending", async () => {
    const { h, admin, createInvite } = await setup();
    const invite = await createInvite();

    expect(invite.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const days = (Date.parse(invite.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    const [row] = await h.db.select().from(invites);
    expect(row?.tokenHash).not.toContain(invite.token);
    expect((await admin.get("/api/household/invites").expect(200)).body).toEqual([
      { id: invite.id, created_at: expect.any(String), expires_at: invite.expires_at },
    ]);
  });

  it("revokes a pending invite; the link then answers 404", async () => {
    const { server, admin, createInvite } = await setup();
    const invite = await createInvite();
    await admin.delete(`/api/household/invites/${invite.id}`).expect(204);
    await admin.delete(`/api/household/invites/${invite.id}`).expect(404);
    expect((await admin.get("/api/household/invites").expect(200)).body).toEqual([]);
    await request(server).get(`/api/invites/${invite.token}`).expect(404);
  });

  it("lists the household's members", async () => {
    const { admin } = await setup();
    expect((await admin.get("/api/household/members").expect(200)).body).toEqual([
      { id: expect.any(Number), username: "admin", role: "admin", joined_at: expect.any(String) },
    ]);
  });
});

describe("invite redemption with a passkey", { timeout: 30_000 }, () => {
  it("creates a signed-in, passwordless member with a passkey, recovery codes, a personal space and a Paperless user", async () => {
    const { h, server, admin, paperless, createInvite } = await setup();
    const invite = await createInvite();

    await request(server).get(`/api/invites/${invite.token}`).expect(200, { expires_at: invite.expires_at });
    const joined = await joinWithInvite(h.app, invite.token, "partner");
    expect(joined.response.body.username).toBe("partner");
    expect(joined.recoveryCodes).toHaveLength(10);
    const invitee = joined.agent;

    expect((await invitee.get("/api/auth/me").expect(200)).body).toEqual({
      username: "partner",
      household_role: "member",
      enrolment_required: false,
      auth_method: "invite",
    });
    const [user] = await h.db.select().from(users).where(eq(users.username, "partner"));
    expect(user!.passwordHash).toBe("!");
    expect(await verifyPassword("anything", user!.passwordHash)).toBe(false);
    const [member] = await h.db.select().from(members).where(eq(members.userId, user!.id));
    expect(member?.role).toBe("member");
    expect(await h.db.select().from(passkeys).where(eq(passkeys.memberId, member!.id))).toHaveLength(1);
    expect(await h.db.select().from(recoveryCodes).where(eq(recoveryCodes.memberId, member!.id))).toHaveLength(10);
    expect(await h.db.select().from(passwordRetirements).where(eq(passwordRetirements.memberId, member!.id))).toHaveLength(1);
    expect(member?.paperlessUserId).not.toBeNull();
    expect(paperless.users.get(member!.paperlessUserId!)?.is_superuser).toBe(false);
    const ownSpace = (await h.db.select().from(spaces)).find((s) => s.personalMemberId === member!.id);
    expect(ownSpace?.paperlessGroupId).not.toBeNull();
    expect(await h.db.select().from(memberPaperlessTokens).where(eq(memberPaperlessTokens.memberId, member!.id))).toHaveLength(1);

    // Private from the first moment: the admin's document is invisible to them.
    paperless.permissions.set(1, {
      owner: (await h.db.select().from(members).where(eq(members.role, "admin")))[0]!.paperlessUserId!,
      permissions: { view: { users: [], groups: [] }, change: { users: [], groups: [] } },
    });
    expect((await invitee.get("/api/library/").expect(200)).body.results).toEqual([]);

    // Admin sees them; the invite is used up.
    expect((await admin.get("/api/household/members").expect(200)).body.map((m: { username: string }) => m.username)).toEqual([
      "admin",
      "partner",
    ]);
    expect((await admin.get("/api/household/invites").expect(200)).body).toEqual([]);
    const [row] = await h.db.select().from(invites);
    expect(row?.redeemedByMemberId).toBe(member!.id);

    // And they sign in with that passkey later; no password exists.
    await request(server).post("/api/auth/login").send({ username: "partner", password: "!" }).expect(401);
  });

  it("the old password redemption route is gone", async () => {
    const { server, createInvite } = await setup();
    const invite = await createInvite();
    await request(server).post(`/api/invites/${invite.token}/redeem`).send({ username: "x", password: "password-1" }).expect(404);
  });

  it("a member cannot manage invites or members", async () => {
    const { h, createInvite } = await setup();
    const invite = await createInvite();
    const { agent: invitee } = await joinWithInvite(h.app, invite.token, "partner");
    await invitee.post("/api/household/invites").expect(403);
    await invitee.get("/api/household/invites").expect(403);
    await invitee.get("/api/household/members").expect(403);
  });

  it("is single use", async () => {
    const { h, server, createInvite } = await setup();
    const invite = await createInvite();
    await joinWithInvite(h.app, invite.token, "one");
    await beginInvite(server, invite.token, "two").expect(404);
    await request(server).get(`/api/invites/${invite.token}`).expect(404);
  });

  it("a cancelled or failed ceremony leaves the invite usable", async () => {
    const { h, server, createInvite } = await setup();
    const invite = await createInvite();
    // Cancelled: begin, never finish.
    await beginInvite(server, invite.token, "partner").expect(200);
    // Failed: a response from the wrong origin.
    const begin = await beginInvite(server, invite.token, "partner").expect(200);
    const bad = new SoftAuthenticator({ origin: "http://evil.example" }).register(begin.body.options);
    await request(server)
      .post(`/api/invites/${invite.token}/register/finish`)
      .set("Origin", ORIGIN)
      .send({ ceremony: begin.body.ceremony, response: bad })
      .expect(401);
    await request(server).get(`/api/invites/${invite.token}`).expect(200);
    expect(await h.db.select().from(users).where(eq(users.username, "partner"))).toHaveLength(0);
    await joinWithInvite(h.app, invite.token, "partner");
  });

  it("rejects an expired link with the same 404", async () => {
    const { h, server, createInvite } = await setup();
    const invite = await createInvite();
    await h.db.execute(sql`UPDATE invites SET expires_at = now() - interval '1 minute'`);
    const check = await request(server).get(`/api/invites/${invite.token}`).expect(404);
    expect(check.body).toEqual({ detail: "Einladung ungültig oder abgelaufen" });
    await beginInvite(server, invite.token, "late").expect(404);
    await request(server).get("/api/invites/not-a-real-token").expect(404, { detail: "Einladung ungültig oder abgelaufen" });
  });

  it("an invalid invite at begin is 404 and counted on the address", async () => {
    const { h, server } = await setup();
    await beginInvite(server, "not-a-real-token", "partner").expect(404);
    const keys = (await h.db.select().from(authRateLimitEvents)).map((row) => row.key);
    expect(keys.filter((key) => key.startsWith("invite:ip:"))).toHaveLength(1);
  });

  it("a taken username is 409 and keeps the invite redeemable", async () => {
    const { h, server, createInvite } = await setup();
    const invite = await createInvite();
    const taken = await beginInvite(server, invite.token, "admin");
    expect(taken.status).toBe(409);
    expect(taken.body.detail).toBe("Benutzername bereits vergeben");
    await joinWithInvite(h.app, invite.token, "partner");
  });

  it("validates the username", async () => {
    const { server, createInvite } = await setup();
    const invite = await createInvite();
    for (const username of ["ab", "has space"]) {
      const response = await beginInvite(server, invite.token, username);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(response.status).not.toBe(404);
    }
  });

  it("refuses an unconfigured origin before any ceremony starts", async () => {
    const { server, createInvite } = await setup();
    const invite = await createInvite();
    await request(server)
      .post(`/api/invites/${invite.token}/register/begin`)
      .set("Origin", "http://192.168.1.5:8080")
      .send({ username: "partner" })
      .expect(400);
  });

  it("only one of two simultaneous redemptions wins", async () => {
    const { h, server, createInvite } = await setup();
    const invite = await createInvite();
    const a = await beginInvite(server, invite.token, "first").expect(200);
    const b = await beginInvite(server, invite.token, "second").expect(200);
    const finish = (begin: request.Response) =>
      request(server)
        .post(`/api/invites/${invite.token}/register/finish`)
        .set("Origin", ORIGIN)
        .send({ ceremony: begin.body.ceremony, response: new SoftAuthenticator().register(begin.body.options) });
    const [ra, rb] = await Promise.all([finish(a), finish(b)]);
    expect([ra.status, rb.status].sort()).toEqual([200, 404]);
    expect(await h.db.select().from(members)).toHaveLength(2);
  });

  it("throttles repeated invalid links per client", async () => {
    const { server } = await setup();
    for (let i = 0; i < 10; i += 1) await request(server).get(`/api/invites/guess-${i}`).expect(404);
    const blocked = await request(server).get("/api/invites/guess-11").expect(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("a Paperless outage doesn't strand the invitee: they're in, provisioning happens later", async () => {
    const { h, paperless, createInvite } = await setup();
    const invite = await createInvite();
    const createUser = paperless.createUser;
    paperless.createUser = async () => {
      throw new Error("paperless down");
    };
    const { agent: invitee } = await joinWithInvite(h.app, invite.token, "partner");
    expect((await invitee.get("/api/auth/me").expect(200)).body.username).toBe("partner");

    paperless.createUser = createUser;
    await invitee.get("/api/library/").expect(200);
    const partner = (await h.db.select().from(members)).find((m) => m.role === "member")!;
    expect(partner.paperlessUserId).not.toBeNull();
  });
});
