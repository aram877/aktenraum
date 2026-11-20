import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { SharesModule } from "../shares/shares.module.js";

import { EventsController } from "./events.controller.js";
import { EventsService } from "./events.service.js";

@Module({
  imports: [AuthModule, SharesModule],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
