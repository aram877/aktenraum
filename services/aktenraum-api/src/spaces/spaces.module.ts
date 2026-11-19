import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { TenancyModule } from "../tenancy/tenancy.module.js";
import { DocumentMoveController, SpacesController } from "./spaces.controller.js";
import { SpacesService } from "./spaces.service.js";

@Module({
  imports: [AuthModule, TenancyModule],
  controllers: [SpacesController, DocumentMoveController],
  providers: [SpacesService],
  exports: [SpacesService],
})
export class SpacesModule {}
