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

import type { PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

import { AuthGuard } from "../auth/auth.guard.js";
import { AuthAuditService } from "../auth/auth-audit.service.js";
import { EnrolmentService } from "../auth/enrolment.service.js";
import { finishSchema } from "../auth/passkeys.controller.js";
import { AuthRateLimiter, inviteIpKey } from "../auth/rate-limiter.js";
import { clientIp } from "../auth/session.service.js";
import { CurrentPrincipal, RequireScope, RequireStepUp, type Principal } from "../auth/principal.js";
import { SetupLinkService } from "../auth/setup.controller.js";
import type { CreatedSetupLink } from "../auth/setup-links.js";
import { WebauthnService, type Ceremony } from "../auth/webauthn.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import {
  HouseholdService,
  INVITE_INVALID,
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
    private readonly setupLinks: SetupLinkService,
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

  /**
   * A single-use setup link (30 minutes) for a member who lost every passkey
   * and recovery code — the admin themselves included. Shown once.
   */
  @Post("members/:id/setup-link")
  @RequireScope("household:admin")
  @RequireStepUp()
  @HttpCode(HttpStatus.CREATED)
  createSetupLink(
    @CurrentPrincipal() principal: Principal,
    @Param("id", ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<CreatedSetupLink> {
    const admin = memberOf(principal);
    return this.setupLinks.issue(id, { memberId: admin.memberId, sessionId: admin.sessionId === null ? null : Number(admin.sessionId) }, request);
  }

  @Post("members/:id/remove")
  @RequireScope("household:admin")
  @RequireStepUp()
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
  @RequireStepUp()
  @HttpCode(HttpStatus.CREATED)
  createInvite(@CurrentPrincipal() principal: Principal): Promise<CreatedInvite> {
    if (principal.kind !== "member") throw new UnauthorizedException("Not authenticated");
    return this.household.createInvite(principal);
  }

  @Delete("invites/:id")
  @RequireScope("household:admin")
  @RequireStepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeInvite(@Param("id", ParseIntPipe) id: number): Promise<void> {
    return this.household.revokeInvite(id);
  }
}

const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[\p{L}\p{N}._-]+$/u, "Nur Buchstaben, Ziffern, Punkt, Unterstrich und Bindestrich");

const inviteBeginSchema = z.object({ username: usernameSchema });
type InviteBeginRequest = z.infer<typeof inviteBeginSchema>;
type InviteFinishRequest = z.infer<typeof finishSchema>;

/**
 * Public on purpose (route-inventory allowlist): the invitee has no session
 * yet. Every invalid state answers the same 404; failures are throttled per
 * client address. Joining = picking a username and creating a passkey
 * (auth-passkeys §8); the invite is claimed only once the ceremony verified.
 */
@Controller("invites")
export class InvitesController {
  constructor(
    private readonly household: HouseholdService,
    private readonly webauthn: WebauthnService,
    private readonly enrolment: EnrolmentService,
    private readonly tenancy: TenancyService,
    private readonly limiter: AuthRateLimiter,
    private readonly audit: AuthAuditService,
  ) {}

  private async guard(request: Request, response: Response): Promise<string> {
    const key = inviteIpKey(clientIp(request));
    const retryAfter = await this.limiter.retryAfterSeconds([key]);
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
      if (error instanceof NotFoundException) await this.limiter.recordFailure([key]);
      throw error;
    }
  }

  @Get(":token")
  async check(
    @Param("token") token: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ expires_at: string }> {
    const key = await this.guard(request, response);
    return this.counted(key, () => this.household.checkInvite(token));
  }

  @Post(":token/register/begin")
  @HttpCode(HttpStatus.OK)
  async registerBegin(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(inviteBeginSchema)) body: InviteBeginRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Ceremony<PublicKeyCredentialCreationOptionsJSON>> {
    const key = await this.guard(request, response);
    const inviteId = await this.counted(key, () => this.household.assertRedeemable(token, body.username));
    const target = this.webauthn.originOf(request);
    return this.webauthn.beginRegistration(target, {
      purpose: "invite",
      userHandle: this.webauthn.newUserHandle(),
      username: body.username,
      inviteId,
    });
  }

  @Post(":token/register/finish")
  @HttpCode(HttpStatus.OK)
  async registerFinish(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(finishSchema)) body: InviteFinishRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ username: string; recovery_codes: string[] | null }> {
    const key = await this.guard(request, response);
    const row = await this.webauthn.claim(body.ceremony, "register");
    if (row === null || row.purpose !== "invite" || row.inviteId === null || row.username === null || row.userHandle === null) {
      await this.limiter.recordFailure([key]);
      throw new NotFoundException(INVITE_INVALID);
    }
    // Verified before anything is claimed: a failed ceremony leaves the invite pending.
    const verified = await this.webauthn.verifyRegistration(row, body.response as unknown as RegistrationResponseJSON);
    const user = await this.counted(key, () =>
      this.household.redeem(token, { username: row.username!, inviteId: row.inviteId! }),
    );
    const member = await this.tenancy.resolveMember(user.id);
    if (member === null) throw new UnauthorizedException("Invalid session");
    await this.webauthn.ensureUserHandle(member.id, row.userHandle);
    const result = await this.enrolment.complete({
      memberId: member.id,
      verified,
      method: "invite",
      request,
      response,
    });
    await this.audit.record("invite_redeemed", { memberId: member.id, sessionId: result.sessionId, request });
    return { username: user.username, recovery_codes: result.recoveryCodes };
  }
}
