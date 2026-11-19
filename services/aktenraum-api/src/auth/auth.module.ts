import { Module } from "@nestjs/common";

import { AuthController } from "./auth.controller.js";
import { AuthGuard } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";
import { InternalGuard, UserOrInternalGuard } from "./internal.guard.js";

@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, InternalGuard, UserOrInternalGuard],
  exports: [AuthService, AuthGuard, InternalGuard, UserOrInternalGuard],
})
export class AuthModule {}
