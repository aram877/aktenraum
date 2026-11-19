import { readFile } from "node:fs/promises";

import { logger } from "@aktenraum/core";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import { SETTINGS, type Settings } from "../config/settings.js";

/**
 * Shape of `backup-status.json`, written by `docker/backup/healthcheck.sh`
 * (hourly, and after every backup run) into the `backup-status` volume.
 */
export const backupStatusFileSchema = z.object({
  checked_at: z.string(),
  healthy: z.boolean(),
  message: z.string(),
  latest_snapshot_at: z.string().nullable(),
  max_age_hours: z.number(),
  last_run_at: z.string().nullable().optional(),
  last_run_exit: z.number().nullable().optional(),
});
export type BackupStatusFile = z.infer<typeof backupStatusFileSchema>;

/**
 * - `ok`: a complete backup exists and is younger than `max_age_hours`
 * - `stale`: the newest complete backup is older than `max_age_hours`
 * - `failing`: the last run failed, the repository cannot be read, or the
 *   backup container stopped reporting
 * - `unknown`: no status file (backup service not deployed, e.g. dev/e2e)
 */
export type BackupState = "ok" | "stale" | "failing" | "unknown";

export interface BackupStatus {
  state: BackupState;
  last_backup_at: string | null;
  age_hours: number | null;
  max_age_hours: number | null;
  checked_at: string | null;
  last_run_at: string | null;
  last_run_exit: number | null;
  detail: string | null;
}

/** The healthcheck writes hourly; silence beyond this means the container is down. */
export const STATUS_SILENCE_HOURS = 3;

const HOUR_MS = 3_600_000;

function hoursSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.floor((now.getTime() - parsed) / HOUR_MS));
}

export function evaluateBackupStatus(file: BackupStatusFile | null, now: Date): BackupStatus {
  if (file === null) {
    return {
      state: "unknown",
      last_backup_at: null,
      age_hours: null,
      max_age_hours: null,
      checked_at: null,
      last_run_at: null,
      last_run_exit: null,
      detail: null,
    };
  }

  const ageHours = hoursSince(file.latest_snapshot_at, now);
  const silenceHours = hoursSince(file.checked_at, now);
  const lastRunExit = file.last_run_exit ?? null;
  const base = {
    last_backup_at: file.latest_snapshot_at,
    age_hours: ageHours,
    max_age_hours: file.max_age_hours,
    checked_at: file.checked_at,
    last_run_at: file.last_run_at ?? null,
    last_run_exit: lastRunExit,
  };

  if (silenceHours === null || silenceHours > STATUS_SILENCE_HOURS) {
    return {
      ...base,
      state: "failing",
      detail: `backup container has not reported for ${silenceHours ?? "?"}h`,
    };
  }
  if (ageHours === null) {
    return { ...base, state: "failing", detail: file.message };
  }
  if (lastRunExit !== null && lastRunExit !== 0) {
    return { ...base, state: "failing", detail: `last backup run exited with ${lastRunExit}` };
  }
  if (ageHours > file.max_age_hours) {
    return { ...base, state: "stale", detail: file.message };
  }
  if (!file.healthy) {
    return { ...base, state: "failing", detail: file.message };
  }
  return { ...base, state: "ok", detail: file.message };
}

@Injectable()
export class BackupStatusService {
  constructor(@Inject(SETTINGS) private readonly settings: Settings) {}

  async readStatusFile(): Promise<BackupStatusFile | null> {
    let raw: string;
    try {
      raw = await readFile(this.settings.BACKUP_STATUS_FILE, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn("backup_status_unreadable", { error: String(error) });
      }
      return null;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      logger.warn("backup_status_invalid_json");
      return null;
    }
    const parsed = backupStatusFileSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn("backup_status_invalid_shape", { issues: parsed.error.issues.length });
      return null;
    }
    return parsed.data;
  }

  async get(now: Date = new Date()): Promise<BackupStatus> {
    return evaluateBackupStatus(await this.readStatusFile(), now);
  }
}
