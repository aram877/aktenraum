import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { ModulesContainer } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ALLOW_RESTRICTED, DOCUMENT_ACCESS, REQUIRED_SCOPES, REQUIRE_STEP_UP } from "../auth/principal.js";
import type { PaperlessGateway } from "../paperless/paperless.gateway.js";
import { FakeGateway } from "./fake-gateway.js";
import { createHarness, type Harness } from "./harness.js";

/** Routes that are public on purpose. Anything else without a guard fails. */
const PUBLIC_ROUTES = new Set([
  "POST /auth/login",
  "POST /auth/logout",
  "GET /health",
  // Invite links: the invitee has no session yet (throttled, uniform 404).
  "GET /invites/:token",
  "POST /invites/:token/register/begin",
  "POST /invites/:token/register/finish",
  // Passkeys (auth-passkeys): sign-in, recovery codes, where passkeys work.
  "GET /auth/webauthn",
  "POST /auth/passkeys/login/begin",
  "POST /auth/passkeys/login/finish",
  "POST /auth/recovery",
  // Setup links: no credential yet (throttled, uniform 404).
  "GET /setup/:token",
  "POST /setup/:token/register/begin",
  "POST /setup/:token/register/finish",
]);

/** The only guarded routes a restricted (password / recovery) session may call. */
const RESTRICTED_ROUTES = [
  "GET /auth/me",
  "POST /auth/passkeys/register/begin",
  "POST /auth/passkeys/register/finish",
];

/** Sensitive routes that need a passkey confirmation within 5 minutes (design §9). */
const STEP_UP_ROUTES = [
  "DELETE /auth/passkeys/:id",
  "DELETE /household/invites/:id",
  "DELETE /spaces/:id",
  "DELETE /spaces/:id/members/:member_id",
  "PATCH /auth/passkeys/:id",
  "PATCH /settings/answer-llm",
  "PATCH /settings/llm",
  "PATCH /spaces/:id/members/:member_id",
  "POST /auth/recovery-codes",
  "POST /household/invites",
  "POST /household/members/:id/remove",
  "POST /household/members/:id/setup-link",
  "POST /spaces/:id/members",
  "POST /trash/:doc_id/delete",
  "POST /trash/empty",
  "PUT /settings/auto-approve",
];

const VERBS: Record<number, string> = { 0: "GET", 1: "POST", 2: "PUT", 3: "DELETE", 4: "PATCH" };

interface RouteInfo {
  id: string;
  guarded: boolean;
  scopes: unknown;
  documentAccess: unknown;
  allowRestricted: boolean;
  stepUp: boolean;
}

let harness: Harness;
let routes: RouteInfo[];

beforeAll(async () => {
  harness = await createHarness({ gateway: new FakeGateway() as unknown as Partial<PaperlessGateway> });
  routes = [];
  for (const module of harness.app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const ctrl = wrapper.metatype as { prototype: Record<string, unknown> } & object;
      const base = String(Reflect.getMetadata(PATH_METADATA, ctrl) ?? "").replace(/^\/|\/$/g, "");
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const handler = ctrl.prototype[name];
        if (typeof handler !== "function" || name === "constructor") continue;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        if (path === undefined) continue;
        const verb = VERBS[Reflect.getMetadata(METHOD_METADATA, handler) as number] ?? "?";
        const full = ["", base, String(path).replace(/^\/|\/$/g, "")].filter(Boolean).join("/");
        const guards = [
          ...((Reflect.getMetadata(GUARDS_METADATA, ctrl) as unknown[]) ?? []),
          ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? []),
        ];
        routes.push({
          id: `${verb} /${full}`,
          guarded: guards.length > 0,
          scopes:
            Reflect.getMetadata(REQUIRED_SCOPES, handler) ?? Reflect.getMetadata(REQUIRED_SCOPES, ctrl),
          documentAccess:
            Reflect.getMetadata(DOCUMENT_ACCESS, handler) ?? Reflect.getMetadata(DOCUMENT_ACCESS, ctrl),
          allowRestricted: (Reflect.getMetadata(ALLOW_RESTRICTED, handler) ?? Reflect.getMetadata(ALLOW_RESTRICTED, ctrl)) === true,
          stepUp: (Reflect.getMetadata(REQUIRE_STEP_UP, handler) ?? Reflect.getMetadata(REQUIRE_STEP_UP, ctrl)) === true,
        });
      }
    }
  }
});

afterAll(async () => {
  await harness.close();
});

describe("route inventory", () => {
  it("finds the controllers", () => {
    expect(routes.length).toBeGreaterThan(40);
  });

  it("guards every route except the explicit public ones", () => {
    const unguarded = routes.filter((r) => !r.guarded).map((r) => r.id).sort();
    expect(unguarded).toEqual([...PUBLIC_ROUTES].sort());
  });

  it("declares a scope on every guarded route", () => {
    const undeclared = routes.filter((r) => r.guarded && !Array.isArray(r.scopes)).map((r) => r.id);
    expect(undeclared).toEqual([]);
  });

  it("guards share management with `share` (home-space owner) and field edits with `edit-fields`", () => {
    const byId = new Map(routes.map((r) => [r.id, r]));
    const shareRoutes = routes.filter((r) => r.id.includes("/documents/:doc_id/shares"));
    expect(shareRoutes.map((r) => r.id).sort()).toEqual([
      "DELETE /documents/:doc_id/shares/:member_id",
      "GET /documents/:doc_id/shares",
      "GET /documents/:doc_id/shares/audit",
      "PATCH /documents/:doc_id/shares/:member_id",
      "POST /documents/:doc_id/shares",
    ]);
    for (const route of shareRoutes) {
      expect(route.documentAccess).toBe("share");
      expect(route.scopes).toEqual(["shares:manage"]);
    }
    expect(byId.get("GET /shares/with-me")?.scopes).toEqual(["shares:manage"]);
    expect(byId.get("GET /shares/by-me")?.scopes).toEqual(["shares:manage"]);
    expect(byId.get("PATCH /documents/:doc_id/fields")?.documentAccess).toBe("edit-fields");
    expect(byId.get("PATCH /documents/:doc_id/type-fields")?.documentAccess).toBe("edit-fields");
    // State changes stay on `write`, which share editors don't hold.
    for (const id of ["POST /inbox/:doc_id/approve", "POST /inbox/:doc_id/reject", "PATCH /inbox/:doc_id", "POST /documents/:doc_id/reprocess", "POST /documents/:doc_id/star"]) {
      expect(byId.get(id)?.documentAccess).toBe("write");
    }
  });

  it("opens exactly the enrolment routes to restricted sessions", () => {
    expect(routes.filter((r) => r.allowRestricted).map((r) => r.id).sort()).toEqual([...RESTRICTED_ROUTES].sort());
  });

  it("requires step-up on exactly the sensitive routes", () => {
    expect(routes.filter((r) => r.stepUp).map((r) => r.id).sort()).toEqual([...STEP_UP_ROUTES].sort());
  });

  it("declares a document action on every route that addresses one document", () => {
    const missing = routes
      .filter((r) => r.id.includes(":doc_id") && r.documentAccess === undefined)
      .map((r) => r.id);
    expect(missing).toEqual([]);
  });
});
