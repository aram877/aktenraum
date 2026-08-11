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
  listTrash(
    @Query("page") page?: string,
    @Query("page_size") pageSize?: string,
    @Query("ordering") ordering?: string,
  ): Promise<TrashList> {
    return this.trashService.listTrashed({
      page: clampInt(page, 1, 1, Number.MAX_SAFE_INTEGER),
      pageSize: clampInt(pageSize, 20, 1, 100),
      ordering:
        ordering !== undefined && ORDERING_ALLOWLIST.has(ordering) ? ordering : undefined,
    });
  }

  @Post("empty")
  @HttpCode(HttpStatus.OK)
  emptyTrash(): Promise<EmptyTrashResponse> {
    return this.trashService.empty();
  }

  @Post(":doc_id/restore")
  @HttpCode(HttpStatus.NO_CONTENT)
  restoreDoc(@Param("doc_id", ParseIntPipe) docId: number): Promise<void> {
    return this.trashService.restore(docId);
  }

  @Post(":doc_id/delete")
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteDocForever(@Param("doc_id", ParseIntPipe) docId: number): Promise<void> {
    return this.trashService.deleteForever(docId);
  }
}
