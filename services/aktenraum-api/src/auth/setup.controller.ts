import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Request, Response } from "express";

import { DB, type Database } from "../db/db.module.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { CredentialAuditService } from "./credential-audit.service.js";
import { EnrolmentService } from "./enrolment.service.js";
import { finishSchema, refuseThrottled, type FinishRequest } from "./passkeys.controller.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { AuthRateLimiter, setupIpKey } from "./rate-limiter.js";
import { clientIp } from "./session.service.js";
import {
  SETUP_INVALID,
  claimSetupLink,
  createSetupLink,
  findPendingSetupLink,
  type CreatedSetupLink,
  type PendingSetupLink,
} from "./setup-links.js";
import { WebauthnService, type Ceremony } from "./webauthn.service.js";

/** Issues setup links from inside the api (household admin). */
@Injectable()
export class SetupLinkService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly tenancy: TenancyService,
    private readonly credentialAudit: CredentialAuditService,
  ) {}

  /** 404 for an unknown or removed member — the same answer as any other member lookup. */
  async issue(memberId: number, actor: { memberId: number; sessionId: number | null }, request: Request): Promise<CreatedSetupLink> {
    const member = await this.tenancy.memberById(memberId);
    if (member === null) throw new NotFoundException(`Member ${memberId} not found`);
    const link = await createSetupLink(this.db, memberId, actor.memberId);
    await this.credentialAudit.record("setup_link_created", {
      memberId,
      actorMemberId: actor.memberId,
      sessionId: actor.sessionId,
      request,
    });
    return link;
  }
}

/**
 * Public on purpose (route-inventory allowlist): whoever opens a setup link
 * has no credential yet. Every invalid state answers the same 404, counted
 * per client address.
 */
@Controller("setup")
export class SetupController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly webauthn: WebauthnService,
    private readonly enrolment: EnrolmentService,
    private readonly limiter: AuthRateLimiter,
    private readonly credentialAudit: CredentialAuditService,
  ) {}

  private async pending(token: string, request: Request, response: Response): Promise<{ link: PendingSetupLink; key: string }> {
    const key = setupIpKey(clientIp(request));
    await refuseThrottled(this.limiter, [key], response);
    const link = await findPendingSetupLink(this.db, token);
    if (link === null) {
      await this.limiter.recordFailure([key]);
      throw new NotFoundException(SETUP_INVALID);
    }
    return { link, key };
  }

  @Get(":token")
  async check(
    @Param("token") token: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ username: string; expires_at: string }> {
    const { link } = await this.pending(token, request, response);
    return { username: link.username, expires_at: link.expiresAt };
  }

  @Post(":token/register/begin")
  @HttpCode(HttpStatus.OK)
  async begin(
    @Param("token") token: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Ceremony<PublicKeyCredentialCreationOptionsJSON>> {
    const { link } = await this.pending(token, request, response);
    const target = this.webauthn.originOf(request);
    return this.webauthn.beginRegistration(target, {
      purpose: "setup",
      userHandle: await this.webauthn.ensureUserHandle(link.memberId),
      username: link.username,
      memberId: link.memberId,
      setupTokenId: link.id,
    });
  }

  @Post(":token/register/finish")
  @HttpCode(HttpStatus.OK)
  async finish(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(finishSchema)) body: FinishRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ username: string; recovery_codes: string[] | null }> {
    const { link, key } = await this.pending(token, request, response);
    const row = await this.webauthn.claim(body.ceremony, "register");
    if (row === null || row.purpose !== "setup" || row.setupTokenId !== link.id || row.memberId !== link.memberId) {
      await this.limiter.recordFailure([key]);
      throw new NotFoundException(SETUP_INVALID);
    }
    const verified = await this.webauthn.verifyRegistration(row, body.response as unknown as RegistrationResponseJSON);
    // Claimed only after a verified ceremony: a failed one leaves the link usable.
    if (!(await claimSetupLink(this.db, link.id))) throw new NotFoundException(SETUP_INVALID);
    const result = await this.enrolment.complete({
      memberId: link.memberId,
      verified,
      method: "setup",
      freshCodes: true,
      request,
      response,
    });
    await this.credentialAudit.record("setup_link_used", {
      memberId: link.memberId,
      sessionId: result.sessionId,
      passkeyId: result.passkey.id,
      request,
    });
    return { username: link.username, recovery_codes: result.recoveryCodes };
  }
}
