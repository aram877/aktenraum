import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { TenancyModule } from "../tenancy/tenancy.module.js";
import { HouseholdController, InvitesController } from "./household.controller.js";
import { HouseholdService } from "./household.service.js";

@Module({
  imports: [AuthModule, TenancyModule],
  controllers: [HouseholdController, InvitesController],
  providers: [HouseholdService],
})
export class HouseholdModule {}
