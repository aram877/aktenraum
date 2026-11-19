import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { SETTINGS, type Settings } from "../config/settings.js";
import { PolicyService } from "../policy/policy.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { AuthService } from "./auth.service.js";
import {
  type MemberPrincipal,
  type PrincipalRequest,
  authorize,
  memberScopes,
} from "./principal.js";

/**
 * Browser requests: the session cookie is read here and nowhere else. Builds
 * the member principal, then runs the route's scope + document-policy check.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector,
    private readonly policy: PolicyService,
    private readonly tenancy: TenancyService,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PrincipalRequest>();
    const token: unknown = request.cookies?.[this.settings.COOKIE_NAME];
    if (typeof token !== "string" || token === "") {
      throw new UnauthorizedException("Not authenticated");
    }
    const user = await this.authService.verifySession(token);
    if (user === null) {
      throw new UnauthorizedException("Invalid session");
    }
    // The JWT carries users.id; tenancy decides who that is in the household.
    const member = await this.tenancy.resolveMember(user.id);
    if (member === null) {
      throw new UnauthorizedException("Invalid session");
    }
    const principal: MemberPrincipal = {
      kind: "member",
      memberId: member.id,
      userId: user.id,
      householdId: member.householdId,
      username: user.username,
      householdRole: member.role,
      scopes: memberScopes(member.role),
      sessionId: null,
      authTime: null,
      clientId: "spa",
    };
    request.principal = principal;
    await authorize(context, principal, this.reflector, this.policy);
    return true;
  }
}
