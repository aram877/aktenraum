import { Module } from "@nestjs/common";

import { MemberGateways } from "./member-gateways.js";
import { TenancyService } from "./tenancy.service.js";

@Module({
  providers: [TenancyService, MemberGateways],
  exports: [TenancyService, MemberGateways],
})
export class TenancyModule {}
