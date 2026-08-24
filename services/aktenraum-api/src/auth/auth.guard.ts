import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import type { Request } from "express";

import { SETTINGS, type Settings } from "../config/settings.js";
import { AuthService, type AuthUser } from "./auth.service.js";
import { verifyToken } from "./jwt.js";

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token: unknown = request.cookies?.[this.settings.COOKIE_NAME];
    if (typeof token !== "string" || token === "") {
      throw new UnauthorizedException("Not authenticated");
    }
    const userId = verifyToken(token, { secret: this.settings.JWT_SECRET });
    if (userId === null) {
      throw new UnauthorizedException("Invalid session");
    }
    const user = await this.authService.findById(userId);
    if (user === null) {
      throw new UnauthorizedException("Invalid session");
    }
    request.user = user;
    return true;
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.user === undefined) {
      throw new UnauthorizedException("Not authenticated");
    }
    return request.user;
  },
);
