import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { ModulesContainer } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashPassword } from "../auth/passwords.js";
import {
  ALLOW_RESTRICTED,
  ALLOW_TOKEN,
  DOCUMENT_ACCESS,
  REQUIRED_SCOPES,
  REQUIRE_STEP_UP,
  SESSION_ONLY,
  TOKEN_SCOPES,
} from "../auth/principal.js";
import { TokenService } from "../auth/tokens.service.js";
import { members, users } from "../db/schema.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
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
  "POST /auth/tokens",
  "POST /household/invites",
  "POST /household/members/:id/remove",
  "POST /household/members/:id/setup-link",
  "POST /spaces/:id/members",
  "POST /trash/:doc_id/delete",
  "POST /trash/empty",
  "PUT /settings/auto-approve",
];

/** The only empty-scope (credential) route a personal access token may call. */
const TOKEN_ROUTES_ALLOWED_EMPTY_SCOPE = ["GET /auth/me"];

/** Routes closed to tokens whatever their scopes (personal-access-tokens D4). */
const SESSION_ONLY_ROUTES = [
  "DELETE /auth/tokens/:id",
  "GET /auth/tokens",
  "GET /events/counts",
  "POST /auth/tokens",
];

const VERBS: Record<number, string> = { 0: "GET", 1: "POST", 2: "PUT", 3: "DELETE", 4: "PATCH" };

interface RouteInfo {
  id: string;
  guarded: boolean;
  scopes: unknown;
  documentAccess: unknown;
  allowRestricted: boolean;
  stepUp: boolean;
  allowToken: boolean;
  sessionOnly: boolean;
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
          allowToken: (Reflect.getMetadata(ALLOW_TOKEN, handler) ?? Reflect.getMetadata(ALLOW_TOKEN, ctrl)) === true,
          sessionOnly: (Reflect.getMetadata(SESSION_ONLY, handler) ?? Reflect.getMetadata(SESSION_ONLY, ctrl)) === true,
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

  it("opens exactly GET /auth/me among the empty-scope routes to tokens", () => {
    expect(routes.filter((r) => r.allowToken).map((r) => r.id).sort()).toEqual([...TOKEN_ROUTES_ALLOWED_EMPTY_SCOPE].sort());
  });

  it("marks exactly the pinned routes session-only", () => {
    expect(routes.filter((r) => r.sessionOnly).map((r) => r.id).sort()).toEqual([...SESSION_ONLY_ROUTES].sort());
  });

  it("answers a valid all-scope token with 403 session_required on every step-up, credential and session-only route", async () => {
    // An admin with every token scope: anything refused here is refused because it is a token.
    await harness.db.insert(users).values({ username: "walker", passwordHash: await hashPassword("password-123") });
    await harness.app.get(TenancyService).reconcile();
    const [member] = await harness.db.select().from(members);
    const { value } = await harness.app.get(TokenService).create(
      { memberId: member!.id, householdId: member!.householdId },
      { name: "walk", scopes: TOKEN_SCOPES, expiresInDays: 1 },
    );
    const denied = routes.filter(
      (r) => r.guarded && Array.isArray(r.scopes)
        && (r.stepUp || r.sessionOnly || ((r.scopes as unknown[]).length === 0 && !r.allowToken)),
    );
    expect(denied.length).toBeGreaterThan(STEP_UP_ROUTES.length);
    const server = harness.app.getHttpServer();
    const wrong: string[] = [];
    for (const route of denied) {
      const [verb, path] = route.id.split(" ") as [string, string];
      const url = "/api" + path.replace(/:[a-z_]+/g, "1");
      const call = (request(server) as unknown as Record<string, (u: string) => request.Test>)[verb.toLowerCase()]!(url);
      const response = await call.set("Authorization", `Bearer ${value}`).send({});
      if (response.status !== 403 || response.body?.detail !== "session_required") {
        wrong.push(`${route.id} → ${response.status} ${JSON.stringify(response.body)}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
