import { logger } from "@aktenraum/core";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { CookieOptions, Request, Response } from "express";

import { SETTINGS, type Settings } from "../config/settings.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { AuthGuard, CurrentUser } from "./auth.guard.js";
import {
  changePasswordRequestSchema,
  loginRequestSchema,
  type ChangePasswordRequest,
  type LoginRequest,
  type UserResponse,
} from "./auth.schemas.js";
import { AuthService, passwordFingerprint, type AuthUser } from "./auth.service.js";
import { LoginThrottle } from "./login-throttle.js";
import { createToken } from "./jwt.js";
import { verifyPassword } from "./passwords.js";

@Controller("auth")
export class AuthController {
  private readonly throttle = new LoginThrottle();

  constructor(
    private readonly authService: AuthService,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.settings.COOKIE_SECURE,
      sameSite: "lax",
      path: "/",
    };
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UserResponse> {
    const key = body.username.trim().toLowerCase();
    const retryAfter = this.throttle.retryAfterSeconds(key);
    if (retryAfter !== null) {
      response.setHeader("Retry-After", String(retryAfter));
      logger.warn("login_throttled", { username: key, ip: request.ip, retry_after: retryAfter });
      throw new HttpException(
        "Zu viele fehlgeschlagene Anmeldeversuche. Bitte später erneut versuchen.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const user = await this.authService.authenticate(body.username, body.password);
    if (user === null) {
      this.throttle.recordFailure(key);
      throw new UnauthorizedException("Invalid credentials");
    }
    this.throttle.reset(key);
    const token = createToken(user.id, {
      secret: this.settings.JWT_SECRET,
      expiresSeconds: this.settings.JWT_EXPIRES_SECONDS,
      fingerprint: passwordFingerprint(user.passwordHash),
    });
    response.cookie(this.settings.COOKIE_NAME, token, {
      ...this.cookieOptions(),
      maxAge: this.settings.JWT_EXPIRES_SECONDS * 1000,
    });
    return { username: user.username };
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) response: Response): void {
    response.clearCookie(this.settings.COOKIE_NAME, { path: "/" });
  }

  @Get("me")
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: AuthUser): UserResponse {
    return { username: user.username };
  }

  @Post("change-password")
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @Body(new ZodValidationPipe(changePasswordRequestSchema)) body: ChangePasswordRequest,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    if (!(await verifyPassword(body.current_password, user.passwordHash))) {
      throw new UnauthorizedException("Current password is incorrect");
    }
    if (body.new_password === body.current_password) {
      throw new BadRequestException("New password must differ from current password");
    }
    await this.authService.setPassword(user.id, body.new_password);
    response.clearCookie(this.settings.COOKIE_NAME, { path: "/" });
  }
}
