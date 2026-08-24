import { Global, Module } from "@nestjs/common";

import { loadSettings, SETTINGS } from "./settings.js";

@Global()
@Module({
  providers: [{ provide: SETTINGS, useFactory: () => loadSettings() }],
  exports: [SETTINGS],
})
export class ConfigModule {}
