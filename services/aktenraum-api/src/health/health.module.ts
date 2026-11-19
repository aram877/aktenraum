import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { BackupStatusService } from "./backup-status.js";
import { HealthController } from "./health.controller.js";

@Module({
  imports: [AuthModule],
  controllers: [HealthController],
  providers: [BackupStatusService],
})
export class HealthModule {}
