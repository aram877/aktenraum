import { Module } from "@nestjs/common";

import { TenancyModule } from "../tenancy/tenancy.module.js";
import { PolicyService } from "./policy.service.js";

@Module({
  imports: [TenancyModule],
  providers: [PolicyService],
  exports: [PolicyService, TenancyModule],
})
export class PolicyModule {}
