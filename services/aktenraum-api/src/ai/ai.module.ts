import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { SharesModule } from "../shares/shares.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { TypeFieldsModule } from "../type-fields/type-fields.module.js";
import { AiController } from "./ai.controller.js";
import { AiService } from "./ai.service.js";
import { LlmBackendProvider } from "./llm-backend.provider.js";
import { RetrievalModule } from "./retrieval.module.js";

@Module({
  imports: [AuthModule, SharesModule, SettingsModule, TypeFieldsModule, RetrievalModule],
  controllers: [AiController],
  providers: [AiService, LlmBackendProvider],
  exports: [AiService],
})
export class AiModule {}
