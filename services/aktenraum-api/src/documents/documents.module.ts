import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { InboxModule } from "../inbox/inbox.module.js";
import { DocumentsController } from "./documents.controller.js";
import { DocumentsService } from "./documents.service.js";

@Module({
  imports: [AuthModule, InboxModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
