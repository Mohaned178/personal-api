import "reflect-metadata";
import { join } from "node:path";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import type { AppConfig } from "./config/config";
import { APP_CONFIG } from "./config/config.module";
import { mountOpenApi } from "./platform/docs/openapi";
import { applyHttpHardening } from "./platform/http/security";
import { mountWebApp } from "./platform/web/web-static";

async function bootstrap(): Promise<void> {
  // Better Auth reads the raw request stream; BodyParserModule re-adds parsing for other routes.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  const config = app.get<AppConfig>(APP_CONFIG);
  applyHttpHardening(app, config.TRUST_PROXY);
  mountOpenApi(app);
  // Optional dashboard build (apps/web/dist); without it the API serves only its own routes.
  mountWebApp(app, config.WEB_DIST_DIR ?? join(__dirname, "../../web/dist"));
  await app.listen(config.PORT);
}

void bootstrap();
