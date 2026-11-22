import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Response } from "express";

import { PolicyService } from "../policy/policy.service.js";
import { AuthGuard } from "./auth.guard.js";
import { BearerAuthenticator, INVALID_CREDENTIAL } from "./bearer.js";
import { type PrincipalRequest, authorize } from "./principal.js";

export { apiServiceCredentials } from "./bearer.js";

/**
 * Service-to-service routes (worker → api). Accepts only
 * `Authorization: Bearer <SVC_TOKEN_WORKER>`; fails closed when it is empty.
 * A personal access token is 401 here. Produces the worker service principal
 * (ADR-010 step 5, `service-credentials`).
 */
@Injectable()
export class InternalGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly policy: PolicyService,
    private readonly bearer: BearerAuthenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PrincipalRequest>();
    if (request.headers.authorization === undefined) throw new UnauthorizedException(INVALID_CREDENTIAL);
    const principal = await this.bearer.authenticate(request, context.switchToHttp().getResponse<Response>(), {
      worker: true,
      token: false,
    });
    request.principal = principal;
    await authorize(context, principal, this.reflector, this.policy);
    return true;
  }
}

/**
 * Routes both the worker and a member may call. A present `Authorization`
 * header is judged alone — the worker credential (`akt_svc_…`) or a personal
 * access token (`akt_pat_…`); anything else is rejected outright and never
 * falls back to the session cookie, so a guessed credential plus a stolen
 * cookie can't pick the weaker check. Without the header the request is
 * authenticated by `AuthGuard`'s cookie path (the SPA never sends
 * `Authorization`).
 */
@Injectable()
export class UserOrInternalGuard implements CanActivate {
  constructor(
    private readonly authGuard: AuthGuard,
    private readonly reflector: Reflector,
    private readonly policy: PolicyService,
    private readonly bearer: BearerAuthenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PrincipalRequest>();
    if (request.headers.authorization === undefined) {
      return this.authGuard.canActivate(context);
    }
    const principal = await this.bearer.authenticate(request, context.switchToHttp().getResponse<Response>(), {
      worker: true,
      token: true,
    });
    request.principal = principal;
    await authorize(context, principal, this.reflector, this.policy);
    return true;
  }
}
