import { Controller, Get, HttpException, HttpStatus, Query, UseGuards } from "@nestjs/common";

import { AuthGuard } from "../auth/auth.guard.js";
import { PaperlessRequestError } from "../paperless/errors.js";
import type { IngestActivity } from "./ingest.schemas.js";
import { IngestService } from "./ingest.service.js";

const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;

function clampDays(raw: string | undefined): number {
  const parsed = Number(raw);
  if (raw === undefined || raw === "" || !Number.isInteger(parsed)) return DEFAULT_DAYS;
  return Math.min(Math.max(parsed, 1), MAX_DAYS);
}

@Controller("ingest")
@UseGuards(AuthGuard)
export class IngestController {
  constructor(private readonly ingestService: IngestService) {}

  @Get("activity")
  async activity(@Query("days") days?: string): Promise<IngestActivity> {
    try {
      return await this.ingestService.activity(clampDays(days));
    } catch (error: unknown) {
      if (error instanceof PaperlessRequestError) {
        throw new HttpException("Paperless is unavailable", HttpStatus.BAD_GATEWAY);
      }
      throw error;
    }
  }
}
