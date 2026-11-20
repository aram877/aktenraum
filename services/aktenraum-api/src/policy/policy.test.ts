import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import request from "supertest";

import { memberScopes, workerPrincipal, type MemberPrincipal } from "../auth/principal.js";
import { hashPassword } from "../auth/passwords.js";
import { documentSpaces, households, members, spaceMembers, spaces, users } from "../db/schema.js";
import { documentShares } from "../db/schema.js";
import type { HouseholdRoleValue, ShareRole, SpaceRole } from "../db/schema.js";
import { createHarness } from "../test/harness.js";
import type { DocumentSpaceAccess, TenancyLookup } from "../tenancy/tenancy.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { PolicyService, shareRoleAllows, spaceRoleAllows, type DocumentAction } from "./policy.service.js";

const ACTIONS: DocumentAction[] = ["read", "write", "edit-fields", "delete", "move", "share"];

function member(role: HouseholdRoleValue, memberId = 1): MemberPrincipal {
  return {
    kind: "member",
    memberId,
    userId: memberId,
    householdId: 1,
    username: `m${memberId}`,
    householdRole: role,
    scopes: memberScopes(role),
    sessionId: null,
    authTime: null,
    clientId: "spa",
  };
}

function policyWith(access: DocumentSpaceAccess): PolicyService {
  const lookup: TenancyLookup = { documentAccess: async () => access };
  return new PolicyService(lookup);
}

describe("PolicyService matrix", () => {
  const expected: Record<SpaceRole, DocumentAction[]> = {
    viewer: ["read"],
    editor: ["read", "write", "edit-fields"],
    owner: ["read", "write", "edit-fields", "delete", "move", "share"],
  };
  const expectedShare: Record<ShareRole, DocumentAction[]> = {
    viewer: ["read"],
    editor: ["read", "edit-fields"],
  };

  for (const [role, allowed] of Object.entries(expected) as [SpaceRole, DocumentAction[]][]) {
    for (const householdRole of ["admin", "member"] as const) {
      it(`space ${role} (household ${householdRole}) may ${allowed.join("/")} only`, async () => {
        const policy = policyWith({ assigned: true, spaceId: 1, role, share: null });
        for (const action of ACTIONS) {
          expect(await policy.canAccessDocument(member(householdRole), 1, action)).toBe(
            allowed.includes(action),
          );
          expect(spaceRoleAllows(role, action)).toBe(allowed.includes(action));
        }
      });
    }
  }

  for (const [share, allowed] of Object.entries(expectedShare) as [ShareRole, DocumentAction[]][]) {
    for (const householdRole of ["admin", "member"] as const) {
      it(`share ${share} (household ${householdRole}) may ${allowed.join("/")} only`, async () => {
        const policy = policyWith({ assigned: true, spaceId: 1, role: null, share });
        for (const action of ACTIONS) {
          expect(await policy.canAccessDocument(member(householdRole), 1, action)).toBe(
            allowed.includes(action),
          );
          expect(shareRoleAllows(share, action)).toBe(allowed.includes(action));
        }
        expect(await policy.accessOf(member(householdRole), 1)).toEqual({ via: "share", role: share });
      });
    }
  }

  it("a space role wins over a share (a member joined the space after the share)", async () => {
    const policy = policyWith({ assigned: true, spaceId: 1, role: "editor", share: "viewer" });
    expect(await policy.canAccessDocument(member("member"), 1, "write")).toBe(true);
    expect(await policy.accessOf(member("member"), 1)).toEqual({ via: "space", role: "editor" });
    const viewer = policyWith({ assigned: true, spaceId: 1, role: "viewer", share: "editor" });
    expect(await viewer.canAccessDocument(member("member"), 1, "edit-fields")).toBe(false);
  });

  it("denies a member outside the home space every action — the household admin too", async () => {
    const policy = policyWith({ assigned: true, spaceId: 1, role: null, share: null });
    for (const action of ACTIONS) {
      expect(await policy.canAccessDocument(member("admin"), 1, action)).toBe(false);
      expect(await policy.canAccessDocument(member("member"), 1, action)).toBe(false);
    }
    expect(await policy.accessOf(member("member"), 1)).toBeNull();
  });

  it("without a home space: household admin only, and nobody can share it", async () => {
    const policy = policyWith({ assigned: false });
    for (const action of ACTIONS) {
      expect(await policy.canAccessDocument(member("admin"), 1, action)).toBe(action !== "share");
      expect(await policy.canAccessDocument(member("member"), 1, action)).toBe(false);
    }
    expect(await policy.accessOf(member("admin"), 1)).toEqual({ via: "admin", role: "admin" });
  });

  it("gives the worker edit-fields (type fields) and read (home space), nothing else, regardless of spaces", async () => {
    for (const access of [
      { assigned: false } as const,
      { assigned: true, spaceId: 1, role: null, share: null } as const,
    ]) {
      const policy = policyWith(access);
      expect(await policy.canAccessDocument(workerPrincipal(), 1, "edit-fields")).toBe(true);
      expect(await policy.canAccessDocument(workerPrincipal(), 1, "read")).toBe(true);
      for (const action of ["write", "delete", "move", "share"] as const) {
        expect(await policy.canAccessDocument(workerPrincipal(), 1, action)).toBe(false);
      }
    }
  });

  it("a service principal without the scope gets nothing", async () => {
    const policy = policyWith({ assigned: false });
    const bare = { kind: "service" as const, service: "worker" as const, scopes: new Set<never>() };
    for (const action of ACTIONS) {
      expect(await policy.canAccessDocument(bare, 1, action)).toBe(false);
    }
  });
});

describe("tenancy-backed policy (pg-mem)", () => {
  it("resolves home space and space role from the database", async () => {
    const h = await createHarness({ env: { BOOTSTRAP_USERNAME: "admin", BOOTSTRAP_PASSWORD: "correct-horse" } });
    try {
      const [second] = await h.db.insert(users).values({ username: "partner", passwordHash: "x" }).returning();
      const tenancy = h.app.get(TenancyService);
      const partner = await tenancy.resolveMember(second!.id);
      expect(partner?.role).toBe("member");

      const admin = (await h.db.select().from(members)).find((m) => m.role === "admin");
      const allSpaces = await h.db.select().from(spaces);
      const adminSpace = allSpaces.find((s) => s.personalMemberId === admin!.id)!;
      await h.db.insert(documentSpaces).values({ paperlessDocId: 100, spaceId: adminSpace.id });
      await h.db.insert(spaceMembers).values({ spaceId: adminSpace.id, memberId: partner!.id, role: "viewer" });

      expect(await tenancy.documentAccess(100, admin!.id)).toEqual({ assigned: true, spaceId: adminSpace.id, role: "owner", share: null });
      expect(await tenancy.documentAccess(100, partner!.id)).toEqual({ assigned: true, spaceId: adminSpace.id, role: "viewer", share: null });
      expect(await tenancy.documentAccess(101, partner!.id)).toEqual({ assigned: false });

      const policy = h.app.get(PolicyService);
      const partnerPrincipal = member("member", partner!.id);
      expect(await policy.canAccessDocument(partnerPrincipal, 100, "read")).toBe(true);
      expect(await policy.canAccessDocument(partnerPrincipal, 100, "write")).toBe(false);
      expect(await policy.canAccessDocument(partnerPrincipal, 101, "read")).toBe(false);

      // Shares: active editor share → edit-fields; an expired one counts as absent.
      await h.db.insert(documentSpaces).values([
        { paperlessDocId: 102, spaceId: adminSpace.id },
        { paperlessDocId: 103, spaceId: adminSpace.id },
      ]);
      await h.db.insert(documentShares).values({ paperlessDocId: 102, memberId: partner!.id, role: "editor", grantedBy: admin!.id });
      await h.db.execute(sql`INSERT INTO document_shares (paperless_doc_id, member_id, role, granted_by, expires_at)
        VALUES (103, ${partner!.id}, 'editor', ${admin!.id}, now() - interval '1 hour')`);
      await h.db.delete(spaceMembers).where(eq(spaceMembers.memberId, partner!.id));
      expect(await tenancy.documentAccess(102, partner!.id)).toEqual({ assigned: true, spaceId: adminSpace.id, role: null, share: "editor" });
      expect(await tenancy.documentAccess(103, partner!.id)).toEqual({ assigned: true, spaceId: adminSpace.id, role: null, share: null });
      expect(await policy.canAccessDocument(partnerPrincipal, 102, "edit-fields")).toBe(true);
      expect(await policy.canAccessDocument(partnerPrincipal, 102, "write")).toBe(false);
      expect(await policy.canAccessDocument(partnerPrincipal, 103, "read")).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("routes: change-password keys on userId and a plain member gets 404 outside its spaces", async () => {
    const h = await createHarness();
    try {
      // users.id and members.id deliberately differ: "owner" is user 2 but member 1.
      const [stranger, owner] = await h.db
        .insert(users)
        .values([
          { username: "stranger", passwordHash: await hashPassword("stranger-pass") },
          { username: "owner", passwordHash: await hashPassword("owner-pass") },
        ])
        .returning();
      const [household] = await h.db.select().from(households); // created at startup
      const [ownerMember] = await h.db
        .insert(members)
        .values({ householdId: household!.id, userId: owner!.id, role: "admin" })
        .returning();
      await h.app.get(TenancyService).reconcile();
      expect(ownerMember!.id).not.toBe(owner!.id);

      const ownerSpace = (await h.db.select().from(spaces)).find((s) => s.personalMemberId === ownerMember!.id)!;
      await h.db.insert(documentSpaces).values({ paperlessDocId: 100, spaceId: ownerSpace.id });

      const server = h.app.getHttpServer();
      const strangerAgent = request.agent(server);
      await strangerAgent.post("/api/auth/login").send({ username: "stranger", password: "stranger-pass" }).expect(200);
      // Denied by the policy before the handler runs (no gateway configured → 503 when allowed).
      await strangerAgent.get("/api/documents/100/status").expect(404);
      await strangerAgent.get("/api/documents/101/status").expect(404);
      expect(stranger!.id).toBeDefined();

      const ownerAgent = request.agent(server);
      await ownerAgent.post("/api/auth/login").send({ username: "owner", password: "owner-pass" }).expect(200);
      await ownerAgent.get("/api/documents/100/status").expect(503);
      await ownerAgent.get("/api/documents/101/status").expect(503);
      await ownerAgent
        .post("/api/auth/change-password")
        .send({ current_password: "owner-pass", new_password: "owner-pass-2" })
        .expect(204);
      await request(server).post("/api/auth/login").send({ username: "owner", password: "owner-pass-2" }).expect(200);
      await request(server).post("/api/auth/login").send({ username: "stranger", password: "stranger-pass" }).expect(200);
    } finally {
      await h.close();
    }
  });
});
