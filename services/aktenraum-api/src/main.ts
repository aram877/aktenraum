import "reflect-metadata";

import { logger, logServiceCredentialCheck } from "@aktenraum/core";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";

import { AppModule } from "./app.module.js";
import { FastApiErrorShapeFilter } from "./common/http-exception.filter.js";
import { createCsrfMiddleware, securityHeadersMiddleware } from "./common/middleware.js";
import { apiServiceCredentials } from "./auth/internal.guard.js";
import { loadSettings } from "./config/settings.js";
import { applySchema } from "./db/apply-schema.js";

export async function bootstrap(): Promise<void> {
  const settings = loadSettings();

  logServiceCredentialCheck(apiServiceCredentials(settings), logger);

  await applySchema(settings.DATABASE_URL);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  // Exactly one proxy hop (nginx) is trusted: request.ip is the right-most
  // X-Forwarded-For entry, which nginx appends from the real socket, so the
  // rate limits, the device list and the auth audit see the browser's address.
  // Only nginx is published; never expose the api port directly.
  app.set("trust proxy", 1);
  app.setGlobalPrefix("api");
  app.use(cookieParser());
  app.use(securityHeadersMiddleware);
  app.use(createCsrfMiddleware());
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
