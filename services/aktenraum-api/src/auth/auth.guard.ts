import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { PolicyService } from "../policy/policy.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import {
  RESTRICTED_SCOPES,
  type MemberPrincipal,
  type PrincipalRequest,
  authorize,
  memberScopes,
} from "./principal.js";
import { SessionService, isRestricted } from "./session.service.js";

/**
 * Browser requests: the session cookie is read here and nowhere else. Builds
 * the member principal, then runs the route's scope + document-policy check.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly reflector: Reflector,
    private readonly policy: PolicyService,
    private readonly tenancy: TenancyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PrincipalRequest>();
    const token = this.sessions.readToken(request);
    if (token === null) {
      throw new UnauthorizedException("Not authenticated");
    }
    // One indexed lookup: active session (SQL expiry) + its member's user.
    const session = await this.sessions.resolve(token);
    if (session === null) {
      throw new UnauthorizedException("Invalid session");
    }
    // Tenancy still decides who that is in the household (removed → null).
    const member = await this.tenancy.resolveMember(session.userId);
    if (member === null || member.id !== session.memberId) {
      throw new UnauthorizedException("Invalid session");
    }
    const restricted = isRestricted(session);
    const principal: MemberPrincipal = {
      kind: "member",
      memberId: member.id,
      userId: session.userId,
      householdId: member.householdId,
      username: session.username,
      householdRole: member.role,
      scopes: restricted ? RESTRICTED_SCOPES : memberScopes(member.role),
      sessionId: String(session.sessionId),
      authTime: new Date(session.createdAt),
      authMethod: session.authMethod,
      restricted,
      stepUpFresh: !restricted && session.stepUpFresh,
      clientId: "spa",
    };
    request.principal = principal;
    await authorize(context, principal, this.reflector, this.policy);
    return true;
  }
}
