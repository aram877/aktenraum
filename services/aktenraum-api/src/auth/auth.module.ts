import { Module } from "@nestjs/common";

import { PolicyModule } from "../policy/policy.module.js";
import { AuthController } from "./auth.controller.js";
import { AuthGuard } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";
import { InternalGuard, UserOrInternalGuard } from "./internal.guard.js";

@Module({
  imports: [PolicyModule],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, InternalGuard, UserOrInternalGuard],
  exports: [AuthService, AuthGuard, InternalGuard, UserOrInternalGuard, PolicyModule],
})
export class AuthModule {}
