import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";

import { AuthGuard } from "../auth/auth.guard.js";
import { DocumentAccess, RequireScope, RequireStepUp, CurrentPrincipal, type Principal } from "../auth/principal.js";
import type { EmptyTrashResponse, TrashList } from "./trash.schemas.js";
import { TrashService } from "./trash.service.js";

const ORDERING_ALLOWLIST: ReadonlySet<string> = new Set([
  "deleted_at",
  "-deleted_at",
  "created",
  "-created",
  "title",
  "-title",
]);

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

@Controller("trash")
@UseGuards(AuthGuard)
export class TrashController {
  constructor(private readonly trashService: TrashService) {}

  @Get()
  @RequireScope("documents:read")
  listTrash(
    @CurrentPrincipal() principal: Principal,
    @Query("page") page?: string,
    @Query("page_size") pageSize?: string,
    @Query("ordering") ordering?: string,
  ): Promise<TrashList> {
    return this.trashService.listTrashed(principal, {
      page: clampInt(page, 1, 1, Number.MAX_SAFE_INTEGER),
      pageSize: clampInt(pageSize, 20, 1, 100),
      ordering:
        ordering !== undefined && ORDERING_ALLOWLIST.has(ordering) ? ordering : undefined,
    });
  }

  @Post("empty")
  @RequireScope("documents:delete")
  @RequireStepUp()
  @HttpCode(HttpStatus.OK)
  emptyTrash(@CurrentPrincipal() principal: Principal): Promise<EmptyTrashResponse> {
    return this.trashService.empty(principal);
  }

  @Post(":doc_id/restore")
  @RequireScope("documents:delete")
  @DocumentAccess("delete")
  @HttpCode(HttpStatus.NO_CONTENT)
  restoreDoc(@CurrentPrincipal() principal: Principal, @Param("doc_id", ParseIntPipe) docId: number): Promise<void> {
    return this.trashService.restore(principal, docId);
  }

  @Post(":doc_id/delete")
  @RequireScope("documents:delete")
  @RequireStepUp()
  @DocumentAccess("delete")
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteDocForever(@CurrentPrincipal() principal: Principal, @Param("doc_id", ParseIntPipe) docId: number): Promise<void> {
    return this.trashService.deleteForever(principal, docId);
  }
}
