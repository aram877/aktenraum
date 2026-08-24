import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { LibraryController } from "./library.controller.js";
import { LibraryService } from "./library.service.js";

@Module({
  imports: [AuthModule],
  controllers: [LibraryController],
  providers: [LibraryService],
  exports: [LibraryService],
})
export class LibraryModule {}
