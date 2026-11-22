import { logger } from "@aktenraum/core";
import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";

import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { AuthGuard } from "./auth.guard.js";
import { CredentialAuditService } from "./credential-audit.service.js";
import {
  CurrentPrincipal,
  RequireScope,
  RequireStepUp,
  SessionOnly,
  TOKEN_SCOPES,
  type MemberPrincipal,
  type Principal,
} from "./principal.js";
import { TOKEN_MAX_DAYS, TokenLimitError, TokenService, type TokenListEntry } from "./tokens.service.js";

export const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(64),
  scopes: z
    .array(z.enum(TOKEN_SCOPES))
    .min(1)
    .max(TOKEN_SCOPES.length)
    .refine((list) => new Set(list).size === list.length, { message: "duplicate scope" }),
  expires_in_days: z.number().int().min(1).max(TOKEN_MAX_DAYS),
});
export type CreateTokenRequest = z.infer<typeof createTokenSchema>;

export interface CreatedToken {
  token: TokenListEntry;
  /** The token value — in this response only, never again. */
  value: string;
}

/**
 * Personal access tokens (personal-access-tokens D8). The caller's own tokens
 * only; browser sessions only (a token can't manage tokens). Creating needs a
 * fresh step-up, revoking doesn't (like ending a session).
 */
@Controller("auth/tokens")
@UseGuards(AuthGuard)
@RequireScope()
@SessionOnly()
export class TokensController {
  constructor(
    private readonly tokens: TokenService,
    private readonly credentialAudit: CredentialAuditService,
  ) {}

  @Get()
  list(@CurrentPrincipal() principal: Principal): Promise<TokenListEntry[]> {
    return this.tokens.list(memberOf(principal).memberId);
  }

  @Post()
  @RequireStepUp()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(createTokenSchema)) body: CreateTokenRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: Request,
  ): Promise<CreatedToken> {
    const member = memberOf(principal);
    try {
      const created = await this.tokens.create(member, {
        name: body.name,
        scopes: body.scopes,
        expiresInDays: body.expires_in_days,
      });
      await this.credentialAudit.record("token_created", {
        memberId: member.memberId,
        actorMemberId: member.memberId,
        sessionId: member.sessionId === null ? null : Number(member.sessionId),
        detail: `${created.token.display_prefix} ${created.token.name}`,
        request,
      });
      logger.info("pat_created", { member_id: member.memberId, token_id: created.token.id, scopes: created.token.scopes.join(",") });
      return created;
    } catch (error: unknown) {
      if (error instanceof TokenLimitError) {
        throw new ConflictException("Zu viele aktive Zugriffstokens (höchstens 25). Bitte zuerst eines widerrufen.");
      }
      throw error;
    }
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @Param("id", ParseIntPipe) id: number,
    @CurrentPrincipal() principal: Principal,
    @Req() request: Request,
  ): Promise<void> {
    const member = memberOf(principal);
    const result = await this.tokens.revoke(member.memberId, id, member.memberId, "user");
    if (result === null) throw new NotFoundException(`Token ${id} not found`);
    if (!result.changed) return;
    await this.credentialAudit.record("token_revoked", {
      memberId: member.memberId,
      actorMemberId: member.memberId,
      sessionId: member.sessionId === null ? null : Number(member.sessionId),
      detail: `${result.token.displayPrefix} ${result.token.name}`,
      request,
    });
    logger.info("pat_revoked", { member_id: member.memberId, token_id: id, reason: "user" });
  }
}

/** AuthGuard only ever produces member principals; this narrows the type. */
function memberOf(principal: Principal): MemberPrincipal {
  if (principal.kind !== "member") throw new UnauthorizedException("Not authenticated");
  return principal;
}
