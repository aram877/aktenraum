import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { SharesModule } from "../shares/shares.module.js";
import { LibraryController } from "./library.controller.js";
import { LibraryService } from "./library.service.js";

@Module({
  imports: [AuthModule, SharesModule],
  controllers: [LibraryController],
  providers: [LibraryService],
  exports: [LibraryService],
})
export class LibraryModule {}
