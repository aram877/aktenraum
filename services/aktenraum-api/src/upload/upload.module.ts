import { tmpdir } from "node:os";

import { Module } from "@nestjs/common";
import { MulterModule } from "@nestjs/platform-express";
import { diskStorage } from "multer";

import { SETTINGS, type Settings } from "../config/settings.js";

import { AuthModule } from "../auth/auth.module.js";
import { UploadController } from "./upload.controller.js";
import { UploadService } from "./upload.service.js";

@Module({
  imports: [
    AuthModule,
    MulterModule.registerAsync({
      inject: [SETTINGS],
      useFactory: (settings: Settings) => ({
        storage: diskStorage({ destination: tmpdir() }),
        limits: { files: settings.UPLOAD_MAX_FILES_PER_REQUEST + 1, fields: 10, fieldSize: 64 * 1024 },
      }),
    }),
  ],
  controllers: [UploadController],
  providers: [UploadService],
  exports: [UploadService],
})
export class UploadModule {}
