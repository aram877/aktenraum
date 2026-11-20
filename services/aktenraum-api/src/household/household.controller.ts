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
  Query,
  Req,
  Res,
  UnauthorizedException,
  UnprocessableEntityException,
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
import {
  MemberRemovalService,
  type RemovalEntry,
  type RemovalPreview,
  type RemovalResult,
} from "./member-removal.service.js";

const removeSchema = z.object({
  confirm_username: z.string().min(1).max(64),
  successor_member_id: z.number().int().positive().optional(),
});
type RemoveRequest = z.infer<typeof removeSchema>;

function memberOf(principal: Principal) {
  if (principal.kind !== "member") throw new UnauthorizedException("Not authenticated");
  return principal;
}

@Controller("household")
@UseGuards(AuthGuard)
export class HouseholdController {
  constructor(
    private readonly household: HouseholdService,
    private readonly removals: MemberRemovalService,
  ) {}

  @Get("members")
  @RequireScope("household:admin")
  members(): Promise<HouseholdMember[]> {
    return this.household.listMembers();
  }

  /** Every member: id + username, to pick whom to add to a space. Nothing else. */
  @Get("directory")
  @RequireScope("spaces:manage")
  directory(): Promise<{ id: number; username: string }[]> {
    return this.household.directory();
  }

  /** What removing `id` would do, with `successor` (default: the admin). Changes nothing. */
  @Get("members/:id/removal-preview")
  @RequireScope("household:admin")
  removalPreview(
    @CurrentPrincipal() principal: Principal,
    @Param("id", ParseIntPipe) id: number,
    @Query("successor") successor?: string,
  ): Promise<RemovalPreview> {
    let successorId: number | undefined;
    if (successor !== undefined && successor !== "") {
      successorId = Number(successor);
      if (!Number.isInteger(successorId) || successorId <= 0) {
        throw new UnprocessableEntityException("Ungültiger Nachfolger");
      }
    }
    return this.removals.preview(memberOf(principal), id, successorId);
  }

  @Post("members/:id/remove")
  @RequireScope("household:admin")
  @HttpCode(HttpStatus.OK)
  removeMember(
    @CurrentPrincipal() principal: Principal,
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(removeSchema)) body: RemoveRequest,
  ): Promise<RemovalResult> {
    return this.removals.remove(memberOf(principal), id, body);
  }

  @Get("removals")
  @RequireScope("household:admin")
  removalList(): Promise<RemovalEntry[]> {
    return this.removals.list();
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
