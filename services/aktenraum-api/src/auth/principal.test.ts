import type { ExecutionContext } from "@nestjs/common";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";

import { PolicyService } from "../policy/policy.service.js";
import type { DocumentSpaceAccess, TenancyLookup } from "../tenancy/tenancy.service.js";
import {
  ALLOW_TOKEN,
  DOCUMENT_ACCESS,
  MEMBER_SCOPES,
  REQUIRE_STEP_UP,
  SESSION_ONLY,
  TOKEN_SCOPES,
  assertStepUp,
  REQUIRED_SCOPES,
  type MemberPrincipal,
  type Principal,
  type Scope,
  authorize,
  memberScopes,
  workerPrincipal,
} from "./principal.js";

function member(scopes: Iterable<Scope> = memberScopes("admin")): MemberPrincipal {
  return {
    kind: "member",
    memberId: 1,
    userId: 1,
    householdId: 1,
    username: "admin",
    householdRole: "admin",
    scopes: new Set(scopes),
    sessionId: null,
    authTime: null,
    clientId: "spa",
    authMethod: "passkey" as const,
    restricted: false,
    stepUpFresh: true,
  };
}

function tokenMember(scopes: Iterable<Scope> = TOKEN_SCOPES): MemberPrincipal {
  return { ...member(scopes), clientId: "pat", authMethod: "token", stepUpFresh: false, token: { id: 1, name: "t" } };
}

/** A fake route: handler metadata + request params, as Nest would provide them. */
function route(
  meta: { scopes?: Scope[]; action?: string; flags?: string[] },
  params: Record<string, string> = {},
) {
  const handler = () => undefined;
  for (const flag of meta.flags ?? []) Reflect.defineMetadata(flag, true, handler);
  if (meta.scopes !== undefined) Reflect.defineMetadata(REQUIRED_SCOPES, meta.scopes, handler);
  if (meta.action !== undefined) Reflect.defineMetadata(DOCUMENT_ACCESS, meta.action, handler);
  class Ctrl {}
  return {
    getHandler: () => handler,
    getClass: () => Ctrl,
    switchToHttp: () => ({ getRequest: () => ({ params }) }),
  } as unknown as ExecutionContext;
}

const reflector = new Reflector();
/** Document 7 has no home space yet; everything else lives in member 1's space. */
const lookup: TenancyLookup = {
  documentAccess: async (docId: number): Promise<DocumentSpaceAccess> =>
    docId === 7 ? { assigned: false } : { assigned: true, spaceId: 1, role: "owner", share: null },
};
const policy = new PolicyService(lookup);
const run = (principal: Principal, context: ExecutionContext) =>
  authorize(context, principal, reflector, policy);

describe("memberScopes", () => {
  it("gives the household admin every member scope", () => {
    expect([...memberScopes("admin")].sort()).toEqual([...MEMBER_SCOPES].sort());
  });

  it("withholds settings:write and household:admin from a plain member", () => {
    const scopes = memberScopes("member");
    expect(scopes.has("settings:write")).toBe(false);
    expect(scopes.has("household:admin")).toBe(false);
    expect(scopes.has("documents:write")).toBe(true);
    expect(scopes.has("spaces:manage")).toBe(true);
  });

  it("gives the worker internal scopes only", () => {
    expect([...workerPrincipal().scopes].sort()).toEqual([
      "internal:settings-read",
      "internal:tenancy-read",
      "internal:tenancy-write",
      "internal:type-fields-write",
    ]);
  });
});

describe("authorize", () => {
  it("refuses a route without a scope declaration", async () => {
    await expect(run(member(), route({}))).rejects.toThrow(
      new ForbiddenException("Route has no scope declaration"),
    );
  });

  it("lets any authenticated principal through an empty declaration", async () => {
    await expect(run(member([]), route({ scopes: [] }))).resolves.toBeUndefined();
  });

  it("requires one of the declared scopes", async () => {
    await expect(run(member(), route({ scopes: ["documents:read"] }))).resolves.toBeUndefined();
    await expect(run(member(["documents:read"]), route({ scopes: ["settings:write"] }))).rejects.toThrow(
      new ForbiddenException("Insufficient scope"),
    );
  });

  it("treats a declaration as any-of", async () => {
    const both = route({ scopes: ["documents:write", "internal:type-fields-write"] });
    await expect(run(workerPrincipal(), both)).resolves.toBeUndefined();
    await expect(run(member(), both)).resolves.toBeUndefined();
  });

  it("keeps the worker off member routes", async () => {
    await expect(run(workerPrincipal(), route({ scopes: ["documents:read"] }))).rejects.toThrow(
      new ForbiddenException("Insufficient scope"),
    );
  });

  it("asks the policy for document routes and hides denials as 404", async () => {
    const remove = route({ scopes: ["internal:type-fields-write"], action: "delete" }, { doc_id: "42" });
    await expect(run(workerPrincipal(), remove)).rejects.toThrow(
      new NotFoundException("Document 42 not found"),
    );
    const write = route({ scopes: ["internal:type-fields-write"], action: "edit-fields" }, { doc_id: "42" });
    await expect(run(workerPrincipal(), write)).resolves.toBeUndefined();
  });

  it("lets the household admin act on a document without a home space", async () => {
    const context = route({ scopes: ["documents:delete"], action: "delete" }, { doc_id: "7" });
    await expect(run(member(), context)).resolves.toBeUndefined();
  });

  it("excludes household administration and settings changes from token scopes", () => {
    expect([...TOKEN_SCOPES].sort()).toEqual(
      MEMBER_SCOPES.filter((scope) => scope !== "household:admin" && scope !== "settings:write").sort(),
    );
  });

  it("refuses a token with session_required on credential, step-up and session-only routes", async () => {
    const refused = new ForbiddenException("session_required");
    await expect(run(tokenMember(), route({ scopes: [] }))).rejects.toThrow(refused);
    await expect(run(tokenMember(), route({ scopes: ["documents:delete"], flags: [REQUIRE_STEP_UP] }))).rejects.toThrow(refused);
    await expect(run(tokenMember(), route({ scopes: ["documents:read"], flags: [SESSION_ONLY] }))).rejects.toThrow(refused);
    await expect(run(tokenMember(), route({ scopes: [], flags: [ALLOW_TOKEN] }))).resolves.toBeUndefined();
    await expect(run(tokenMember(), route({ scopes: ["documents:read"] }))).resolves.toBeUndefined();
    await expect(run(tokenMember(["upload"]), route({ scopes: ["documents:read"] }))).rejects.toThrow(
      new ForbiddenException("Insufficient scope"),
    );
    // A session is unaffected by the token markers.
    await expect(run(member(), route({ scopes: ["documents:read"], flags: [SESSION_ONLY] }))).resolves.toBeUndefined();
    expect(() => assertStepUp(tokenMember())).toThrow(refused);
    expect(() => assertStepUp(member())).not.toThrow();
  });
});
