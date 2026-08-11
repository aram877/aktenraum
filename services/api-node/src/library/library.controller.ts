import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Query,
  UseGuards,
} from "@nestjs/common";

import { AuthGuard } from "../auth/auth.guard.js";
import type { LibraryList, TagFacetList } from "./library.schemas.js";
import { LibraryService } from "./library.service.js";

const ALLOWED_ORDERING = [
  "-added",
  "-created",
  "-modified",
  "-title",
  "added",
  "created",
  "modified",
  "title",
];

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function toArray(raw: string | string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw : [raw];
}

function optionalDate(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new HttpException(
      { detail: [{ loc: ["query"], msg: "invalid date format, expected YYYY-MM-DD", type: "value_error.date" }] },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  return raw;
}

@Controller("library")
@UseGuards(AuthGuard)
export class LibraryController {
  constructor(private readonly libraryService: LibraryService) {}

  @Get()
  listLibrary(
    @Query("document_type") documentType?: string,
    @Query("correspondent") correspondent?: string,
    @Query("date_from") dateFrom?: string,
    @Query("date_to") dateTo?: string,
    @Query("text") text?: string,
    @Query("tags") tags?: string | string[],
    @Query("page") page?: string,
    @Query("page_size") pageSize?: string,
    @Query("ordering") ordering?: string,
  ): Promise<LibraryList> {
    const resolvedOrdering = ordering ?? "-created";
    if (!ALLOWED_ORDERING.includes(resolvedOrdering)) {
      throw new HttpException(
        `ordering must be one of ${JSON.stringify(ALLOWED_ORDERING)}`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return this.libraryService.listLibrary({
      documentType,
      correspondent,
      dateFrom: optionalDate(dateFrom),
      dateTo: optionalDate(dateTo),
      text,
      tags: toArray(tags),
      page: clampInt(page, 1, 1, Number.MAX_SAFE_INTEGER),
      pageSize: clampInt(pageSize, 25, 1, 100),
      ordering: resolvedOrdering,
    });
  }

  @Get("tags")
  listTagFacet(): Promise<TagFacetList> {
    return this.libraryService.listTagFacet();
  }
}
