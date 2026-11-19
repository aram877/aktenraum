import { secretMatches } from "@aktenraum/core";
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { SETTINGS, type Settings } from "../config/settings.js";
import { AuthGuard } from "./auth.guard.js";

export const INTERNAL_SECRET_HEADER = "x-aktenraum-secret";

/**
 * Service-to-service routes (worker → api). Accepts only a matching
 * `X-Aktenraum-Secret`; fails closed when `WEBHOOK_SECRET` is empty.
 * Becomes the `kind: "service"` principal in ADR-010 step 5.
 */
@Injectable()
export class InternalGuard implements CanActivate {
  constructor(@Inject(SETTINGS) private readonly settings: Settings) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!secretMatches(request.headers[INTERNAL_SECRET_HEADER], this.settings.WEBHOOK_SECRET)) {
      throw new UnauthorizedException("Bad secret");
    }
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
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers[INTERNAL_SECRET_HEADER];
    if (provided !== undefined) {
      if (secretMatches(provided, this.settings.WEBHOOK_SECRET)) return true;
      throw new UnauthorizedException("Invalid secret");
    }
    return this.authGuard.canActivate(context);
  }
}
