import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { TrashController } from "./trash.controller.js";
import { TrashService } from "./trash.service.js";

@Module({
  imports: [AuthModule],
  controllers: [TrashController],
  providers: [TrashService],
  exports: [TrashService],
})
export class TrashModule {}
