import { Module } from "@nestjs/common";

import { TenancyService } from "./tenancy.service.js";

@Module({
  providers: [TenancyService],
  exports: [TenancyService],
})
export class TenancyModule {}
