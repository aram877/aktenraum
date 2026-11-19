import type { ExecutionContext } from "@nestjs/common";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";

import { PolicyService } from "../policy/policy.service.js";
import type { DocumentSpaceAccess, TenancyLookup } from "../tenancy/tenancy.service.js";
import {
  DOCUMENT_ACCESS,
  MEMBER_SCOPES,
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
  };
}

/** A fake route: handler metadata + request params, as Nest would provide them. */
function route(meta: { scopes?: Scope[]; action?: string }, params: Record<string, string> = {}) {
  const handler = () => undefined;
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
    docId === 7 ? { assigned: false } : { assigned: true, spaceId: 1, role: "owner" },
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
  });

  it("gives the worker internal scopes only", () => {
    expect([...workerPrincipal().scopes].sort()).toEqual([
      "internal:settings-read",
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
    const read = route({ scopes: ["internal:type-fields-write"], action: "read" }, { doc_id: "42" });
    await expect(run(workerPrincipal(), read)).rejects.toThrow(
      new NotFoundException("Document 42 not found"),
    );
    const write = route({ scopes: ["internal:type-fields-write"], action: "write" }, { doc_id: "42" });
    await expect(run(workerPrincipal(), write)).resolves.toBeUndefined();
  });

  it("lets the household admin act on a document without a home space", async () => {
    const context = route({ scopes: ["documents:delete"], action: "delete" }, { doc_id: "7" });
    await expect(run(member(), context)).resolves.toBeUndefined();
  });
});
