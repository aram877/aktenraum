import "reflect-metadata";

import { logger } from "@aktenraum/core-ts";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";

import { AppModule } from "./app.module.js";
import { FastApiErrorShapeFilter } from "./common/http-exception.filter.js";
import { csrfMiddleware, securityHeadersMiddleware } from "./common/middleware.js";
import { loadSettings } from "./config/settings.js";

export async function bootstrap(): Promise<void> {
  const settings = loadSettings();

  if (!settings.WEBHOOK_SECRET) {
    logger.warn("webhook_secret_unset", {
      detail:
        "WEBHOOK_SECRET is empty — the internal /api/settings/active-* endpoints " +
        "are unauthenticated and rely on Docker network isolation alone. Set " +
        "WEBHOOK_SECRET (bootstrap-secrets.sh generates one) in docker/.env.",
    });
  }

  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.setGlobalPrefix("api");
  app.use(cookieParser());
  app.use(securityHeadersMiddleware);
  app.use(csrfMiddleware);
  app.useGlobalFilters(new FastApiErrorShapeFilter());

  await app.listen(settings.PORT, "0.0.0.0");
  logger.info("api_started", { port: settings.PORT });
}

bootstrap().catch((error: unknown) => {
  logger.error("api_start_failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
