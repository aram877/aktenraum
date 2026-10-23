import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { IngestController } from "./ingest.controller.js";
import { IngestService } from "./ingest.service.js";

@Module({
  imports: [AuthModule],
  controllers: [IngestController],
  providers: [IngestService],
})
export class IngestModule {}
