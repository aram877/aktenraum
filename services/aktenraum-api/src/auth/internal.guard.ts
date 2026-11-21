import { serviceCaller, type ServiceCredentials } from "@aktenraum/core";
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

function isWorker(authorization: unknown, settings: Settings): boolean {
  return serviceCaller(authorization, apiServiceCredentials(settings)) === "worker";
}

/**
 * Service-to-service routes (worker → api). Accepts only
 * `Authorization: Bearer <SVC_TOKEN_WORKER>`; fails closed when it is empty.
 * Produces the worker service principal (ADR-010 step 5, `service-credentials`).
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
    if (!isWorker(request.headers.authorization, this.settings)) {
      throw new UnauthorizedException("Invalid credential");
    }
    const principal = workerPrincipal();
    request.principal = principal;
    await authorize(context, principal, this.reflector, this.policy);
    return true;
  }
}

/**
 * Routes both the worker and a logged-in user may call. A present
 * `Authorization` header must carry the worker credential — anything else is
 * rejected outright and never falls back to the session cookie, so a guessed
 * credential plus a stolen cookie can't pick the weaker check. Without the
 * header the request is authenticated by `AuthGuard`, the one place that
 * reads the session cookie (the SPA never sends `Authorization`).
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
    const provided = request.headers.authorization;
    if (provided === undefined) {
      return this.authGuard.canActivate(context);
    }
    if (!isWorker(provided, this.settings)) {
      throw new UnauthorizedException("Invalid credential");
    }
    const principal = workerPrincipal();
    request.principal = principal;
    await authorize(context, principal, this.reflector, this.policy);
    return true;
  }
}
