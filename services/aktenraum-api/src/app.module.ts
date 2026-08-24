import { Module } from "@nestjs/common";

import { AiModule } from "./ai/ai.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { AutoTaggerModule } from "./auto-tagger/auto-tagger.module.js";
import { ConfigModule } from "./config/config.module.js";
import { DbModule } from "./db/db.module.js";
import { DocumentsModule } from "./documents/documents.module.js";
import { EventsModule } from "./events/events.module.js";
import { HealthModule } from "./health/health.module.js";
import { InboxModule } from "./inbox/inbox.module.js";
import { LibraryModule } from "./library/library.module.js";
import { PaperlessModule } from "./paperless/paperless.module.js";
import { RagModule } from "./rag/rag.module.js";
import { SettingsModule } from "./settings/settings.module.js";
import { TrashModule } from "./trash/trash.module.js";
import { TypeFieldsModule } from "./type-fields/type-fields.module.js";
import { UploadModule } from "./upload/upload.module.js";

@Module({
  imports: [
    ConfigModule,
    DbModule,
    PaperlessModule,
    AutoTaggerModule,
    RagModule,
    HealthModule,
    AuthModule,
    SettingsModule,
    AiModule,
    DocumentsModule,
    UploadModule,
    InboxModule,
    LibraryModule,
    TrashModule,
    TypeFieldsModule,
    EventsModule,
  ],
})
export class AppModule {}
