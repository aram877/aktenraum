import { Global, Inject, Injectable, Module, ServiceUnavailableException } from "@nestjs/common";

import { SETTINGS, type Settings } from "../config/settings.js";
import { PaperlessGateway } from "./paperless.gateway.js";

export const PAPERLESS_GATEWAY = Symbol("AKTENRAUM_PAPERLESS_GATEWAY");

@Injectable()
export class PaperlessGatewayProvider {
  constructor(@Inject(PAPERLESS_GATEWAY) private readonly gateway: PaperlessGateway | null) {}

  require(): PaperlessGateway {
    if (this.gateway === null) {
      throw new ServiceUnavailableException("Paperless API token not configured");
    }
    return this.gateway;
  }

  optional(): PaperlessGateway | null {
    return this.gateway;
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PAPERLESS_GATEWAY,
      inject: [SETTINGS],
      useFactory: (settings: Settings): PaperlessGateway | null =>
        settings.PAPERLESS_API_TOKEN
          ? new PaperlessGateway(settings.PAPERLESS_BASE_URL, settings.PAPERLESS_API_TOKEN, {
              ttlSeconds: settings.CORRESPONDENT_LIST_TTL_SECONDS,
            })
          : null,
    },
    PaperlessGatewayProvider,
  ],
  exports: [PAPERLESS_GATEWAY, PaperlessGatewayProvider],
})
export class PaperlessModule {}
