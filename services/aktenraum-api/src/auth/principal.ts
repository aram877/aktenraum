import {
  type ExecutionContext,
  ForbiddenException,
  NotFoundException,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import type { Request } from "express";

import type { SessionAuthMethod, ShareAccessKindValue } from "../db/schema.js";
import type { DocumentAction, PolicyService } from "../policy/policy.service.js";

/**
 * Who is calling (ADR-010 §4). Authentication builds exactly one principal per
 * request; nothing else reads cookies or secrets, and no secret travels with it.
 */

export const MEMBER_SCOPES = [
  "documents:read",
  "documents:write",
  "documents:delete",
  "upload",
  "ai:ask",
  "settings:read",
  "settings:write",
  "shares:manage",
  "spaces:manage",
  "household:admin",
] as const;

export const INTERNAL_SCOPES = [
  "internal:settings-read",
  "internal:type-fields-write",
  "internal:tenancy-write",
  "internal:tenancy-read",
] as const;

/** The only scope of a restricted session: enrol a passkey (auth-passkeys §4). */
export const ENROL_SCOPE = "auth:enrol" as const;

export type MemberScope = (typeof MEMBER_SCOPES)[number];
export type InternalScope = (typeof INTERNAL_SCOPES)[number];
export type Scope = MemberScope | InternalScope | typeof ENROL_SCOPE;

export type HouseholdRole = "admin" | "member";

const ADMIN_ONLY: ReadonlySet<Scope> = new Set<Scope>(["settings:write", "household:admin"]);

export function memberScopes(role: HouseholdRole): ReadonlySet<Scope> {
  return new Set<Scope>(
    role === "admin" ? MEMBER_SCOPES : MEMBER_SCOPES.filter((scope) => !ADMIN_ONLY.has(scope)),
  );
}

export const RESTRICTED_SCOPES: ReadonlySet<Scope> = new Set<Scope>([ENROL_SCOPE]);

/** The worker reads its settings, writes type fields, assigns and reads home spaces — nothing else. */
export const WORKER_SCOPES: ReadonlySet<Scope> = new Set<Scope>(INTERNAL_SCOPES);

export interface MemberPrincipal {
  readonly kind: "member";
  /** `members.id` — what policy, spaces and shares key on. */
  readonly memberId: number;
  /** `users.id` — only for credential code (login, change password). */
  readonly userId: number;
  readonly householdId: number;
  readonly username: string;
  readonly householdRole: HouseholdRole;
  readonly scopes: ReadonlySet<Scope>;
  /** `sessions.id` of the browser session (auth-server-sessions). */
  readonly sessionId: string | null;
  /** When the session was created (login / invite redemption). */
  readonly authTime: Date | null;
  /** How the session was started. */
  readonly authMethod: SessionAuthMethod;
  /**
   * May only enrol a passkey: password or recovery-code session, or no
   * active passkey. Such a principal holds only `auth:enrol`.
   */
  readonly restricted: boolean;
  /** A passkey confirmation within the last 5 minutes (step-up). */
  readonly stepUpFresh: boolean;
  readonly clientId: "spa";
}

export interface ServicePrincipal {
  readonly kind: "service";
  readonly service: "worker";
  readonly scopes: ReadonlySet<Scope>;
}

export type Principal = MemberPrincipal | ServicePrincipal;

export interface PrincipalRequest extends Request {
  principal?: Principal;
}

export function workerPrincipal(): ServicePrincipal {
  return { kind: "service", service: "worker", scopes: WORKER_SCOPES };
}

// ---------------------------------------------------------------------------
// Route declarations
// ---------------------------------------------------------------------------

export const REQUIRED_SCOPES = "aktenraum:required-scopes";
export const DOCUMENT_ACCESS = "aktenraum:document-access";
export const SHARE_ACCESS_KIND = "aktenraum:share-access-kind";
export const ALLOW_RESTRICTED = "aktenraum:allow-restricted";
export const REQUIRE_STEP_UP = "aktenraum:require-step-up";

export const ENROLMENT_REQUIRED = "enrolment_required";
export const STEP_UP_REQUIRED = "step_up_required";

/**
 * Scopes a route accepts — the principal needs ANY of them. No arguments means
 * "any authenticated principal" (declared on purpose, unlike a forgotten one).
 */
export const RequireScope = (...scopes: Scope[]) => SetMetadata(REQUIRED_SCOPES, scopes);

/** The route addresses one document by `:doc_id`; the policy decides the action. */
export const DocumentAccess = (action: DocumentAction) => SetMetadata(DOCUMENT_ACCESS, action);

/**
 * A read route whose use by a share recipient is audited (detail, preview,
 * download). Space members are never logged.
 */
export const ShareAccessKind = (kind: Exclude<ShareAccessKindValue, "ask">) => SetMetadata(SHARE_ACCESS_KIND, kind);

/**
 * A route a restricted session (password / recovery before enrolment) may
 * call. Every other route answers 403 `enrolment_required` to it — deny by
 * default, so a forgotten marker fails closed.
 */
export const AllowRestricted = () => SetMetadata(ALLOW_RESTRICTED, true);

/** A sensitive route: needs a passkey confirmation within 5 minutes (403 `step_up_required`). */
export const RequireStepUp = () => SetMetadata(REQUIRE_STEP_UP, true);

/** The same refusal `authorize` gives, for routes that need step-up only in some cases. */
export function assertStepUp(principal: MemberPrincipal): void {
  if (!principal.stepUpFresh) throw new ForbiddenException(STEP_UP_REQUIRED);
}

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const request = context.switchToHttp().getRequest<PrincipalRequest>();
    if (request.principal === undefined) {
      throw new UnauthorizedException("Not authenticated");
    }
    return request.principal;
  },
);

/**
 * The one authorization step, run by every auth guard after it has built the
 * principal (a global guard would run before the principal exists).
 */
export async function authorize(
  context: ExecutionContext,
  principal: Principal,
  reflector: Reflector,
  policy: PolicyService,
): Promise<void> {
  const targets = [context.getHandler(), context.getClass()];
  const required = reflector.getAllAndOverride<Scope[] | undefined>(REQUIRED_SCOPES, targets);
  if (required === undefined) {
    throw new ForbiddenException("Route has no scope declaration");
  }
  // Before scopes: an unmarked route is closed to a restricted session even
  // when it declares "any authenticated principal".
  if (principal.kind === "member" && principal.restricted
      && reflector.getAllAndOverride<boolean | undefined>(ALLOW_RESTRICTED, targets) !== true) {
    throw new ForbiddenException(ENROLMENT_REQUIRED);
  }
  if (required.length > 0 && !required.some((scope) => principal.scopes.has(scope))) {
    throw new ForbiddenException("Insufficient scope");
  }
  if (principal.kind === "member" && reflector.getAllAndOverride<boolean | undefined>(REQUIRE_STEP_UP, targets) === true) {
    assertStepUp(principal);
  }

  const action = reflector.getAllAndOverride<DocumentAction | undefined>(DOCUMENT_ACCESS, targets);
  if (action === undefined) return;
  const request = context.switchToHttp().getRequest<PrincipalRequest>();
  const docId = Number(request.params?.doc_id);
  const accessKind = reflector.getAllAndOverride<ShareAccessKindValue | undefined>(SHARE_ACCESS_KIND, targets);
  if (!Number.isInteger(docId) || !(await policy.authorizeDocument(principal, docId, action, accessKind))) {
    throw new NotFoundException(`Document ${request.params?.doc_id} not found`);
  }
}
