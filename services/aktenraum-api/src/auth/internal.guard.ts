import { secretMatches } from "@aktenraum/core";
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
import { AuthGuard } from "./auth.guard.js";
import { type PrincipalRequest, authorize, workerPrincipal } from "./principal.js";

export const INTERNAL_SECRET_HEADER = "x-aktenraum-secret";

/**
 * Service-to-service routes (worker → api). Accepts only a matching
 * `X-Aktenraum-Secret`; fails closed when `WEBHOOK_SECRET` is empty.
 * Produces the worker service principal (per-caller credentials: ADR-010 step 5).
 */
@Injectable()
export class InternalGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly policy: PolicyService,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PrincipalRequest>();
    if (!secretMatches(request.headers[INTERNAL_SECRET_HEADER], this.settings.WEBHOOK_SECRET)) {
      throw new UnauthorizedException("Bad secret");
    }
    const principal = workerPrincipal();
    request.principal = principal;
    await authorize(context, principal, this.reflector, this.policy);
    return true;
  }
}

/**
 * Routes both the worker and a logged-in user may call. A present secret must
 * match — a wrong one is rejected outright and never falls back to the session
 * cookie, so a guessed secret plus a stolen cookie can't pick the weaker check.
 * Without the header the request is authenticated by `AuthGuard`, the one
 * place that reads the session cookie.
 */
@Injectable()
export class UserOrInternalGuard implements CanActivate {
  constructor(
    private readonly authGuard: AuthGuard,
    private readonly reflector: Reflector,
    private readonly policy: PolicyService,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PrincipalRequest>();
    const provided = request.headers[INTERNAL_SECRET_HEADER];
    if (provided === undefined) {
      return this.authGuard.canActivate(context);
    }
    if (!secretMatches(provided, this.settings.WEBHOOK_SECRET)) {
      throw new UnauthorizedException("Invalid secret");
    }
    const principal = workerPrincipal();
    request.principal = principal;
    await authorize(context, principal, this.reflector, this.policy);
    return true;
  }
}
