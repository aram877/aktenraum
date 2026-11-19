import { Global, Inject, Injectable, Module, ServiceUnavailableException } from "@nestjs/common";

import { SETTINGS, type Settings } from "../config/settings.js";
import { PaperlessGateway } from "./paperless.gateway.js";

export const PAPERLESS_GATEWAY = Symbol("AKTENRAUM_PAPERLESS_GATEWAY");
/** Builds a gateway for one member's Paperless token (overridden in tests). */
export const PAPERLESS_GATEWAY_FACTORY = Symbol("AKTENRAUM_PAPERLESS_GATEWAY_FACTORY");
export type PaperlessGatewayFactory = (token: string) => PaperlessGateway;

@Injectable()
export class PaperlessGatewayProvider {
  constructor(@Inject(PAPERLESS_GATEWAY) private readonly gateway: PaperlessGateway | null) {}

  /**
   * The SERVICE gateway (superuser token). Member requests must use
   * `MemberGateways.forPrincipal` instead — every remaining call of this is a
   * deliberate household-wide operation (worker routes, tenancy, admin views).
   */
  service(): PaperlessGateway {
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
    {
      provide: PAPERLESS_GATEWAY_FACTORY,
      inject: [SETTINGS],
      useFactory:
        (settings: Settings): PaperlessGatewayFactory =>
        (token: string) =>
          new PaperlessGateway(settings.PAPERLESS_BASE_URL, token, {
            ttlSeconds: settings.CORRESPONDENT_LIST_TTL_SECONDS,
          }),
    },
    PaperlessGatewayProvider,
  ],
  exports: [PAPERLESS_GATEWAY, PAPERLESS_GATEWAY_FACTORY, PaperlessGatewayProvider],
})
export class PaperlessModule {}
