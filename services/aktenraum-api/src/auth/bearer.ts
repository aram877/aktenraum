import { bearerValue, logger, serviceCaller, type ServiceCredentials } from "@aktenraum/core";
import { HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request, Response } from "express";

import { SETTINGS, type Settings } from "../config/settings.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { CredentialAuditService } from "./credential-audit.service.js";
import { memberScopes, workerPrincipal, type MemberPrincipal, type Principal, type Scope } from "./principal.js";
import { AuthRateLimiter, tokenIpKey } from "./rate-limiter.js";
import { clientIp } from "./session.service.js";
import { TOKEN_PREFIX, TokenService } from "./tokens.service.js";

/**
 * The credentials the api holds: the worker's (verified here) and its own
 * (sent to the worker). Both are in the verification map so a value shared
 * between them fails closed, but only `worker` is ever accepted — the api's
 * own token, like the Paperless hook's (which the api never holds), is 401.
 */
export function apiServiceCredentials(
  settings: Pick<Settings, "SVC_TOKEN_WORKER" | "SVC_TOKEN_API">,
): ServiceCredentials {
  return { worker: settings.SVC_TOKEN_WORKER, api: settings.SVC_TOKEN_API };
}

export const INVALID_CREDENTIAL = "Invalid credential";
export const INVALID_TOKEN = "Invalid token";

/** Which bearer kinds a guard accepts. */
export interface BearerAccept {
  /** `akt_svc_…` = the worker's service credential. */
  worker: boolean;
  /** `akt_pat_…` = a member's personal access token. */
  token: boolean;
}

/**
 * Every `Authorization` header is judged here and only here
 * (personal-access-tokens D3). The prefix picks the check: `akt_pat_` → the
 * token table, anything else → the worker credential (constant-time compare
 * via `serviceCaller`). A header that passes neither is 401 — the caller
 * never falls back to the session cookie.
 */
@Injectable()
export class BearerAuthenticator {
  constructor(
    private readonly tokens: TokenService,
    private readonly tenancy: TenancyService,
    private readonly limiter: AuthRateLimiter,
    private readonly credentialAudit: CredentialAuditService,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  async authenticate(request: Request, response: Response, accept: BearerAccept): Promise<Principal> {
    const header = request.headers.authorization;
    const value = bearerValue(header);
    if (value !== null && value.startsWith(TOKEN_PREFIX)) {
      if (!accept.token) throw new UnauthorizedException(INVALID_CREDENTIAL);
      return this.tokenPrincipal(request, response, value);
    }
    if (accept.worker && serviceCaller(header, apiServiceCredentials(this.settings)) === "worker") {
      return workerPrincipal();
    }
    throw new UnauthorizedException(accept.worker ? INVALID_CREDENTIAL : INVALID_TOKEN);
  }

  private async tokenPrincipal(request: Request, response: Response, value: string): Promise<MemberPrincipal> {
    const ip = clientIp(request);
    const key = tokenIpKey(ip);
    const retryAfter = await this.limiter.retryAfterSeconds([key]);
    if (retryAfter !== null) {
      response.setHeader("Retry-After", String(retryAfter));
      logger.warn("pat_throttled", { ip, retry_after: retryAfter });
      throw new HttpException(
        "Zu viele ungültige Zugriffstokens. Bitte später erneut versuchen.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const resolution = await this.tokens.resolve(value, ip);
    if (resolution.status === "active") {
      const { token } = resolution;
      // Tenancy decides membership, as for sessions (removed member → null).
      const member = await this.tenancy.resolveMember(token.userId);
      if (member !== null && member.id === token.memberId) {
        const allowed = memberScopes(member.role);
        return {
          kind: "member",
          memberId: member.id,
          userId: token.userId,
          householdId: member.householdId,
          username: token.username,
          householdRole: member.role,
          // A role downgrade shrinks existing tokens without touching rows.
          scopes: new Set<Scope>(token.scopes.filter((scope) => allowed.has(scope))),
          sessionId: null,
          authTime: new Date(token.createdAt),
          authMethod: "token",
          restricted: false,
          stepUpFresh: false,
          clientId: "pat",
          token: { id: token.id, name: token.name },
        };
      }
    }

    // Unknown, expired, revoked, or a removed member: all look the same to the
    // caller. A success never resets the count (a prober can't clear its own).
    await this.limiter.recordFailure([key]);
    logger.warn("pat_rejected", { status: resolution.status === "active" ? "member_gone" : resolution.status, ip });
    if (resolution.status === "expired" && resolution.auditDue) {
      await this.credentialAudit.record("token_rejected_expired", {
        memberId: resolution.memberId,
        detail: `${resolution.displayPrefix} ${resolution.name}`,
        request,
      });
    }
    throw new UnauthorizedException(INVALID_TOKEN);
  }
}
