import { Module } from "@nestjs/common";

import { PolicyModule } from "../policy/policy.module.js";
import { AuthController } from "./auth.controller.js";
import { AuthAuditService } from "./auth-audit.service.js";
import { AuthGuard } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";
import { AuthSweepService } from "./auth-sweep.service.js";
import { AuthRateLimiter } from "./rate-limiter.js";
import { SessionService } from "./session.service.js";
import { InternalGuard, UserOrInternalGuard } from "./internal.guard.js";

@Module({
  imports: [PolicyModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthGuard,
    InternalGuard,
    UserOrInternalGuard,
    SessionService,
    AuthRateLimiter,
    AuthAuditService,
    AuthSweepService,
  ],
  exports: [
    AuthService,
    AuthGuard,
    InternalGuard,
    UserOrInternalGuard,
    PolicyModule,
    SessionService,
    AuthRateLimiter,
    AuthAuditService,
  ],
})
export class AuthModule {}
