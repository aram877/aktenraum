import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";

import { AuthGuard } from "../auth/auth.guard.js";
import {
  CurrentPrincipal,
  DocumentAccess,
  RequireScope,
  type MemberPrincipal,
  type Principal,
} from "../auth/principal.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import {
  SharesService,
  type ShareAuditEntry,
  type ShareEntry,
  type SharedByMeEntry,
  type SharedWithMeEntry,
} from "./shares.service.js";

const roleSchema = z.enum(["viewer", "editor"]);
const expiresSchema = z.string().datetime({ offset: true }).nullable();

const grantSchema = z.object({
  member_id: z.number().int().positive(),
  role: roleSchema,
  expires_at: expiresSchema.optional(),
});
type GrantBody = z.infer<typeof grantSchema>;

const changeSchema = z
  .object({ role: roleSchema.optional(), expires_at: expiresSchema.optional() })
  .refine((body) => body.role !== undefined || body.expires_at !== undefined, {
    message: "role or expires_at is required",
  });
type ChangeBody = z.infer<typeof changeSchema>;

function member(principal: Principal): MemberPrincipal {
  if (principal.kind !== "member") throw new UnauthorizedException("Not authenticated");
  return principal;
}

/**
 * Shares of one document. `@DocumentAccess("share")` = owner of the home
 * space; anyone else gets 404, like every other document route.
 */
@Controller("documents")
@UseGuards(AuthGuard)
export class DocumentSharesController {
  constructor(private readonly shares: SharesService) {}

  @Get(":doc_id/shares")
  @RequireScope("shares:manage")
  @DocumentAccess("share")
  list(@Param("doc_id", ParseIntPipe) docId: number): Promise<ShareEntry[]> {
    return this.shares.list(docId);
  }

  @Get(":doc_id/shares/audit")
  @RequireScope("shares:manage")
  @DocumentAccess("share")
  audit(@Param("doc_id", ParseIntPipe) docId: number): Promise<ShareAuditEntry[]> {
    return this.shares.audit(docId);
  }

  @Post(":doc_id/shares")
  @RequireScope("shares:manage")
  @DocumentAccess("share")
  @HttpCode(HttpStatus.CREATED)
  grant(
    @CurrentPrincipal() principal: Principal,
    @Param("doc_id", ParseIntPipe) docId: number,
    @Body(new ZodValidationPipe(grantSchema)) body: GrantBody,
  ): Promise<ShareEntry> {
    return this.shares.grant(member(principal), docId, body);
  }

  @Patch(":doc_id/shares/:member_id")
  @RequireScope("shares:manage")
  @DocumentAccess("share")
  change(
    @CurrentPrincipal() principal: Principal,
    @Param("doc_id", ParseIntPipe) docId: number,
    @Param("member_id", ParseIntPipe) memberId: number,
    @Body(new ZodValidationPipe(changeSchema)) body: ChangeBody,
  ): Promise<ShareEntry> {
    return this.shares.change(member(principal), docId, memberId, body);
  }

  @Delete(":doc_id/shares/:member_id")
  @RequireScope("shares:manage")
  @DocumentAccess("share")
  @HttpCode(HttpStatus.NO_CONTENT)
  revoke(
    @CurrentPrincipal() principal: Principal,
    @Param("doc_id", ParseIntPipe) docId: number,
    @Param("member_id", ParseIntPipe) memberId: number,
  ): Promise<void> {
    return this.shares.revoke(member(principal), docId, memberId);
  }
}

/** The caller's two share lists ("Mit mir geteilt" / "Von mir geteilt"). */
@Controller("shares")
@UseGuards(AuthGuard)
export class SharesController {
  constructor(private readonly shares: SharesService) {}

  @Get("with-me")
  @RequireScope("shares:manage")
  withMe(@CurrentPrincipal() principal: Principal): Promise<SharedWithMeEntry[]> {
    return this.shares.withMe(member(principal));
  }

  @Get("by-me")
  @RequireScope("shares:manage")
  byMe(@CurrentPrincipal() principal: Principal): Promise<SharedByMeEntry[]> {
    return this.shares.byMe(member(principal));
  }
}
