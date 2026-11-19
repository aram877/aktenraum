import { Controller, Get, UseGuards } from "@nestjs/common";

import { AuthGuard } from "../auth/auth.guard.js";
import { BackupStatusService, type BackupStatus } from "./backup-status.js";

@Controller("health")
export class HealthController {
  constructor(private readonly backupStatus: BackupStatusService) {}

  @Get()
  health(): { status: string } {
    return { status: "ok" };
  }

  @Get("backup")
  @UseGuards(AuthGuard)
  async backup(): Promise<BackupStatus> {
    return this.backupStatus.get();
  }
}
