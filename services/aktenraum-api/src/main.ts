import "reflect-metadata";

import { logger } from "@aktenraum/core";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";

import { AppModule } from "./app.module.js";
import { FastApiErrorShapeFilter } from "./common/http-exception.filter.js";
import { createCsrfMiddleware, securityHeadersMiddleware } from "./common/middleware.js";
import { loadSettings } from "./config/settings.js";
import { applySchema } from "./db/apply-schema.js";

export async function bootstrap(): Promise<void> {
  const settings = loadSettings();

  if (!settings.WEBHOOK_SECRET) {
    logger.warn("webhook_secret_unset", {
      detail:
        "WEBHOOK_SECRET is empty — the internal /api/settings/active-* endpoints " +
        "reject every call, so the auto-tagger falls back to OLLAMA_MODEL and " +
        "fail-closed auto-approve rules. Run scripts/bootstrap-secrets.sh.",
    });
  }

  await applySchema(settings.DATABASE_URL);

  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.setGlobalPrefix("api");
  app.use(cookieParser());
  app.use(securityHeadersMiddleware);
  app.use(createCsrfMiddleware(settings.WEBHOOK_SECRET));
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
