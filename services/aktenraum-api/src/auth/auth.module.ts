import { Module } from "@nestjs/common";

import { PolicyModule } from "../policy/policy.module.js";
import { AuthController } from "./auth.controller.js";
import { AuthAuditService } from "./auth-audit.service.js";
import { AuthGuard } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";
import { AuthSweepService } from "./auth-sweep.service.js";
import { CredentialAuditService } from "./credential-audit.service.js";
import { EnrolmentService } from "./enrolment.service.js";
import { InternalGuard, UserOrInternalGuard } from "./internal.guard.js";
import { PasskeysController } from "./passkeys.controller.js";
import { AuthRateLimiter } from "./rate-limiter.js";
import { RecoveryCodesService } from "./recovery-codes.service.js";
import { SessionService } from "./session.service.js";
import { SetupController, SetupLinkService } from "./setup.controller.js";
import { WebauthnService } from "./webauthn.service.js";

@Module({
  imports: [PolicyModule],
  controllers: [AuthController, PasskeysController, SetupController],
  providers: [
    AuthService,
    AuthGuard,
    InternalGuard,
    UserOrInternalGuard,
    SessionService,
    AuthRateLimiter,
    AuthAuditService,
    AuthSweepService,
    CredentialAuditService,
    WebauthnService,
    EnrolmentService,
    RecoveryCodesService,
    SetupLinkService,
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
    CredentialAuditService,
    WebauthnService,
    EnrolmentService,
    SetupLinkService,
  ],
})
export class AuthModule {}
