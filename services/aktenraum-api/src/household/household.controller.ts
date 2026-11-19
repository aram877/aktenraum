import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";

import { AuthGuard } from "../auth/auth.guard.js";
import { AuthService } from "../auth/auth.service.js";
import { LoginThrottle } from "../auth/login-throttle.js";
import { CurrentPrincipal, RequireScope, type Principal } from "../auth/principal.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import {
  HouseholdService,
  type CreatedInvite,
  type HouseholdMember,
  type PendingInvite,
} from "./household.service.js";

@Controller("household")
@UseGuards(AuthGuard)
export class HouseholdController {
  constructor(private readonly household: HouseholdService) {}

  @Get("members")
  @RequireScope("household:admin")
  members(): Promise<HouseholdMember[]> {
    return this.household.listMembers();
  }

  @Get("invites")
  @RequireScope("household:admin")
  pendingInvites(): Promise<PendingInvite[]> {
    return this.household.listInvites();
  }

  @Post("invites")
  @RequireScope("household:admin")
  @HttpCode(HttpStatus.CREATED)
  createInvite(@CurrentPrincipal() principal: Principal): Promise<CreatedInvite> {
    if (principal.kind !== "member") throw new UnauthorizedException("Not authenticated");
    return this.household.createInvite(principal);
  }

  @Delete("invites/:id")
  @RequireScope("household:admin")
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeInvite(@Param("id", ParseIntPipe) id: number): Promise<void> {
    return this.household.revokeInvite(id);
  }
}

const redeemSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[\p{L}\p{N}._-]+$/u, "Nur Buchstaben, Ziffern, Punkt, Unterstrich und Bindestrich"),
  password: z.string().min(8).max(128),
});
type RedeemRequest = z.infer<typeof redeemSchema>;

/**
 * Public on purpose (route-inventory allowlist): the invitee has no session
 * yet. Every invalid state answers the same 404; failures are throttled per
 * client address.
 */
@Controller("invites")
export class InvitesController {
  private readonly throttle = new LoginThrottle();

  constructor(
    private readonly household: HouseholdService,
    private readonly auth: AuthService,
  ) {}

  private guard(request: Request, response: Response): string {
    const key = `invite:${request.ip ?? "unknown"}`;
    const retryAfter = this.throttle.retryAfterSeconds(key);
    if (retryAfter !== null) {
      response.setHeader("Retry-After", String(retryAfter));
      throw new HttpException(
        "Zu viele Versuche. Bitte später erneut versuchen.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return key;
  }

  private async counted<T>(key: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error: unknown) {
      if (error instanceof NotFoundException) this.throttle.recordFailure(key);
      throw error;
    }
  }

  @Get(":token")
  async check(
    @Param("token") token: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ expires_at: string }> {
    const key = this.guard(request, response);
    return this.counted(key, () => this.household.checkInvite(token));
  }

  @Post(":token/redeem")
  @HttpCode(HttpStatus.OK)
  async redeem(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(redeemSchema)) body: RedeemRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ username: string }> {
    const key = this.guard(request, response);
    const user = await this.counted(key, () => this.household.redeem(token, body));
    this.auth.issueSession(response, user);
    return { username: user.username };
  }
}
