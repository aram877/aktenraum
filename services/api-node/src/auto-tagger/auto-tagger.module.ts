import { Global, Module } from "@nestjs/common";

import { AutoTaggerClient } from "./auto-tagger.client.js";

@Global()
@Module({
  providers: [AutoTaggerClient],
  exports: [AutoTaggerClient],
})
export class AutoTaggerModule {}
