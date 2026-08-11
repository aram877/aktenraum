import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { TypeFieldsModule } from "../type-fields/type-fields.module.js";
import { InboxController } from "./inbox.controller.js";
import { InboxService } from "./inbox.service.js";

@Module({
  imports: [AuthModule, TypeFieldsModule],
  controllers: [InboxController],
  providers: [InboxService],
  exports: [InboxService],
})
export class InboxModule {}
