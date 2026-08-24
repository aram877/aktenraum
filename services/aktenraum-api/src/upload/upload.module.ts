import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { UploadController } from "./upload.controller.js";
import { UploadService } from "./upload.service.js";

@Module({
  imports: [AuthModule],
  controllers: [UploadController],
  providers: [UploadService],
  exports: [UploadService],
})
export class UploadModule {}
