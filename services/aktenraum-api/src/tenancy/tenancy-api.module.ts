import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { HomeSpaceService } from "./home-space.service.js";
import { TenancyController } from "./tenancy.controller.js";
import { TenancyModule } from "./tenancy.module.js";

/**
 * HTTP side of tenancy. Separate from `TenancyModule` because the auth guards
 * depend on `TenancyService` (via the policy) — importing `AuthModule` there
 * would be circular.
 */
@Module({
  imports: [AuthModule, TenancyModule],
  controllers: [TenancyController],
  providers: [HomeSpaceService],
  exports: [HomeSpaceService],
})
export class TenancyApiModule {}
