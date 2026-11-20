import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { TenancyModule } from "../tenancy/tenancy.module.js";
import { DocumentSharesController, SharesController } from "./shares.controller.js";
import { SharesService } from "./shares.service.js";

@Module({
  imports: [AuthModule, TenancyModule],
  controllers: [DocumentSharesController, SharesController],
  providers: [SharesService],
  exports: [SharesService],
})
export class SharesModule {}
