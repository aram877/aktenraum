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
    // Until ADR-009 step 3 adds members, every user is the household admin.
    const principal: MemberPrincipal = {
      kind: "member",
      memberId: user.id,
      username: user.username,
      householdRole: "admin",
      scopes: memberScopes("admin"),
      sessionId: null,
      authTime: null,
      clientId: "spa",
    };
    request.principal = principal;
    await authorize(context, principal, this.reflector, this.policy);
    return true;
  }
}
