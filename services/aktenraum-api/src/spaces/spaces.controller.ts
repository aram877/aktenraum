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
  RequireStepUp,
  type MemberPrincipal,
  type Principal,
} from "../auth/principal.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import {
  BULK_MOVE_LIMIT,
  SpacesService,
  type MoveResult,
  type SpaceList,
  type SpaceMemberEntry,
  type SpaceSummary,
} from "./spaces.service.js";

const nameSchema = z.object({ name: z.string().trim().min(1).max(128) });
type NameRequest = z.infer<typeof nameSchema>;

const roleSchema = z.enum(["editor", "viewer"]);
const addMemberSchema = z.object({ member_id: z.number().int().positive(), role: roleSchema });
type AddMemberRequest = z.infer<typeof addMemberSchema>;
const changeRoleSchema = z.object({ role: roleSchema });
type ChangeRoleRequest = z.infer<typeof changeRoleSchema>;

const moveSchema = z.object({ space_id: z.number().int().positive() });
type MoveRequest = z.infer<typeof moveSchema>;
const bulkMoveSchema = z.object({
  doc_ids: z.array(z.number().int().positive()).min(1).max(BULK_MOVE_LIMIT),
});
type BulkMoveRequest = z.infer<typeof bulkMoveSchema>;

function member(principal: Principal): MemberPrincipal {
  if (principal.kind !== "member") throw new UnauthorizedException("Not authenticated");
  return principal;
}

/** Shared spaces ("Akten"): every member may manage the spaces they own (ADR-009). */
@Controller("spaces")
@UseGuards(AuthGuard)
export class SpacesController {
  constructor(private readonly spaces: SpacesService) {}

  @Get()
  @RequireScope("spaces:manage")
  list(@CurrentPrincipal() principal: Principal): Promise<SpaceList> {
    return this.spaces.list(member(principal));
  }

  @Post()
  @RequireScope("spaces:manage")
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(nameSchema)) body: NameRequest,
  ): Promise<SpaceSummary> {
    return this.spaces.create(member(principal), body.name);
  }

  @Patch(":id")
  @RequireScope("spaces:manage")
  @HttpCode(HttpStatus.NO_CONTENT)
  rename(
    @CurrentPrincipal() principal: Principal,
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(nameSchema)) body: NameRequest,
  ): Promise<void> {
    return this.spaces.rename(member(principal), id, body.name);
  }

  @Delete(":id")
  @RequireScope("spaces:manage")
  @RequireStepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentPrincipal() principal: Principal, @Param("id", ParseIntPipe) id: number): Promise<void> {
    return this.spaces.remove(member(principal), id);
  }

  @Get(":id/members")
  @RequireScope("spaces:manage")
  members(@CurrentPrincipal() principal: Principal, @Param("id", ParseIntPipe) id: number): Promise<SpaceMemberEntry[]> {
    return this.spaces.listMembers(member(principal), id);
  }

  @Post(":id/members")
  @RequireScope("spaces:manage")
  @RequireStepUp()
  @HttpCode(HttpStatus.CREATED)
  addMember(
    @CurrentPrincipal() principal: Principal,
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(addMemberSchema)) body: AddMemberRequest,
  ): Promise<SpaceMemberEntry> {
    return this.spaces.addMember(member(principal), id, body.member_id, body.role);
  }

  @Patch(":id/members/:member_id")
  @RequireScope("spaces:manage")
  @RequireStepUp()
  changeRole(
    @CurrentPrincipal() principal: Principal,
    @Param("id", ParseIntPipe) id: number,
    @Param("member_id", ParseIntPipe) memberId: number,
    @Body(new ZodValidationPipe(changeRoleSchema)) body: ChangeRoleRequest,
  ): Promise<SpaceMemberEntry> {
    return this.spaces.changeRole(member(principal), id, memberId, body.role);
  }

  /** The owner removes a member; any non-owner may remove themselves (leave). */
  @Delete(":id/members/:member_id")
  @RequireScope("spaces:manage")
  @RequireStepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  removeMember(
    @CurrentPrincipal() principal: Principal,
    @Param("id", ParseIntPipe) id: number,
    @Param("member_id", ParseIntPipe) memberId: number,
  ): Promise<void> {
    return this.spaces.removeMember(member(principal), id, memberId);
  }

  /** Bulk move into this space; per-document outcome. */
  @Post(":id/documents")
  @RequireScope("spaces:manage")
  @HttpCode(HttpStatus.OK)
  bulkMove(
    @CurrentPrincipal() principal: Principal,
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(bulkMoveSchema)) body: BulkMoveRequest,
  ): Promise<{ results: MoveResult[] }> {
    return this.spaces.bulkMove(member(principal), id, body.doc_ids);
  }
}

@Controller("documents")
@UseGuards(AuthGuard)
export class DocumentMoveController {
  constructor(private readonly spaces: SpacesService) {}

  /**
   * Readable documents only (404 otherwise); moving out needs `owner` on the
   * current space (403), moving in `owner`/`editor` on the target.
   */
  @Post(":doc_id/move")
  @RequireScope("spaces:manage")
  @DocumentAccess("read")
  @HttpCode(HttpStatus.OK)
  move(
    @CurrentPrincipal() principal: Principal,
    @Param("doc_id", ParseIntPipe) docId: number,
    @Body(new ZodValidationPipe(moveSchema)) body: MoveRequest,
  ): Promise<MoveResult> {
    return this.spaces.moveDocument(member(principal), docId, body.space_id);
  }
}
