import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { invites, memberPaperlessTokens, members, spaces, users } from "../db/schema.js";
import type { PaperlessGateway } from "../paperless/paperless.gateway.js";
import { FakeGateway, TAGS, makeDoc } from "../test/fake-gateway.js";
import { createHarness, type Harness } from "../test/harness.js";

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
  const createInvite = async () => (await admin.post("/api/household/invites").expect(201)).body as {
    id: number;
    token: string;
    expires_at: string;
  };
  return { h, server, admin, paperless, createInvite };
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

describe("invite redemption", { timeout: 30_000 }, () => {
  it("creates a logged-in member with an empty personal space and their own Paperless user + token", async () => {
    const { h, server, admin, paperless, createInvite } = await setup();
    const invite = await createInvite();
    const invitee = request.agent(server);

    await invitee.get(`/api/invites/${invite.token}`).expect(200, { expires_at: invite.expires_at });
    const redeemed = await invitee
      .post(`/api/invites/${invite.token}/redeem`)
      .send({ username: "partner", password: "partner-password" })
      .expect(200);
    expect(redeemed.body).toEqual({ username: "partner" });

    expect((await invitee.get("/api/auth/me").expect(200)).body).toEqual({ username: "partner", household_role: "member" });
    const [user] = await h.db.select().from(users).where(eq(users.username, "partner"));
    const [member] = await h.db.select().from(members).where(eq(members.userId, user!.id));
    expect(member?.role).toBe("member");
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
  });

  it("a member cannot manage invites or members", async () => {
    const { server, createInvite } = await setup();
    const invite = await createInvite();
    const invitee = request.agent(server);
    await invitee.post(`/api/invites/${invite.token}/redeem`).send({ username: "partner", password: "partner-password" }).expect(200);

    await invitee.post("/api/household/invites").expect(403);
    await invitee.get("/api/household/invites").expect(403);
    await invitee.get("/api/household/members").expect(403);
  });

  it("is single use", async () => {
    const { server, createInvite } = await setup();
    const invite = await createInvite();
    await request(server).post(`/api/invites/${invite.token}/redeem`).send({ username: "one", password: "password-1" }).expect(200);
    await request(server).post(`/api/invites/${invite.token}/redeem`).send({ username: "two", password: "password-2" }).expect(404);
    await request(server).get(`/api/invites/${invite.token}`).expect(404);
  });

  it("rejects an expired link with the same 404", async () => {
    const { h, server, createInvite } = await setup();
    const invite = await createInvite();
    await h.db.execute(sql`UPDATE invites SET expires_at = now() - interval '1 minute'`);
    const check = await request(server).get(`/api/invites/${invite.token}`).expect(404);
    expect(check.body).toEqual({ detail: "Einladung ungültig oder abgelaufen" });
    await request(server).post(`/api/invites/${invite.token}/redeem`).send({ username: "late", password: "password-1" }).expect(404);
    await request(server).get("/api/invites/not-a-real-token").expect(404, { detail: "Einladung ungültig oder abgelaufen" });
  });

  it("a taken username is 409 and keeps the invite redeemable", async () => {
    const { server, createInvite } = await setup();
    const invite = await createInvite();
    const taken = await request(server).post(`/api/invites/${invite.token}/redeem`).send({ username: "admin", password: "password-1" });
    expect(taken.status).toBe(409);
    expect(taken.body.detail).toBe("Benutzername bereits vergeben");
    await request(server).post(`/api/invites/${invite.token}/redeem`).send({ username: "partner", password: "password-1" }).expect(200);
  });

  it("validates username and password", async () => {
    const { server, createInvite } = await setup();
    const invite = await createInvite();
    for (const body of [
      { username: "ab", password: "password-1" },
      { username: "has space", password: "password-1" },
      { username: "partner", password: "short" },
    ]) {
      const response = await request(server).post(`/api/invites/${invite.token}/redeem`).send(body);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(response.status).not.toBe(404);
    }
  });

  it("only one of two simultaneous redemptions wins", async () => {
    const { h, server, createInvite } = await setup();
    const invite = await createInvite();
    const [a, b] = await Promise.all([
      request(server).post(`/api/invites/${invite.token}/redeem`).send({ username: "first", password: "password-1" }),
      request(server).post(`/api/invites/${invite.token}/redeem`).send({ username: "second", password: "password-2" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    expect(await h.db.select().from(members)).toHaveLength(2);
  });

  it("throttles repeated invalid links per client", async () => {
    const { server } = await setup();
    for (let i = 0; i < 10; i += 1) await request(server).get(`/api/invites/guess-${i}`).expect(404);
    const blocked = await request(server).get("/api/invites/guess-11").expect(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("a Paperless outage doesn't strand the invitee: they're in, provisioning happens later", async () => {
    const { h, server, paperless, createInvite } = await setup();
    const invite = await createInvite();
    const createUser = paperless.createUser;
    paperless.createUser = async () => {
      throw new Error("paperless down");
    };
    const invitee = request.agent(server);
    await invitee.post(`/api/invites/${invite.token}/redeem`).send({ username: "partner", password: "partner-password" }).expect(200);
    expect((await invitee.get("/api/auth/me").expect(200)).body.username).toBe("partner");

    paperless.createUser = createUser;
    await invitee.get("/api/library/").expect(200);
    const partner = (await h.db.select().from(members)).find((m) => m.role === "member")!;
    expect(partner.paperlessUserId).not.toBeNull();
  });
});
