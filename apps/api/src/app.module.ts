import { Module } from "@nestjs/common";
import { APP_FILTER, APP_PIPE } from "@nestjs/core";
import { INGEST_MAX_BATCH_BYTES } from "@personal-api/contracts";
import { LoggerModule } from "nestjs-pino";
import type { AppConfig } from "./config/config";
import { APP_CONFIG, ConfigModule } from "./config/config.module";
import { ActivityModule } from "./modules/activity/activity.module";
import { isAuthPath } from "./modules/auth/auth.http";
import { AuthModule } from "./modules/auth/auth.module";
import { DeletionsModule } from "./modules/deletions/deletions.module";
import { DiagnosticsModule } from "./modules/diagnostics/diagnostics.module";
import { EndpointsModule } from "./modules/endpoints/endpoints.module";
import { EventsModule } from "./modules/events/events.module";
import { INGEST_EVENTS_PATH } from "./modules/ingest/ingest.controller";
import { IngestModule } from "./modules/ingest/ingest.module";
import { IntegrationsModule } from "./modules/integrations/integrations.module";
import { KeysModule } from "./modules/keys/keys.module";
import { PairingModule } from "./modules/pairing/pairing.module";
import { RetentionModule } from "./modules/retention/retention.module";
import { RulesModule } from "./modules/rules/rules.module";
import { SettingsModule } from "./modules/settings/settings.module";
import { ClockModule } from "./platform/clock/clock.module";
import { DbModule } from "./platform/db/db.module";
import { ProblemFilter } from "./platform/errors/problem.filter";
import { HealthModule } from "./platform/health/health.module";
import { BodyParserModule } from "./platform/http/body-parser.module";
import { RequestValidationPipe } from "./platform/http/request-validation";
import { JobsModule } from "./platform/jobs/jobs.module";
import { buildPinoHttpOptions } from "./platform/logging/logging";

@Module({
  imports: [
    ConfigModule,
    ClockModule,
    // The app is created with `bodyParser: false`; this parses bodies for every route except
    // Better Auth's, which needs the raw stream. Every route keeps the 100 KB default except the
    // ingest events route, which takes batches of up to 256 KB.
    BodyParserModule.forRoot({
      skip: isAuthPath,
      largeJsonRoutes: [
        { method: "POST", path: INGEST_EVENTS_PATH, limitBytes: INGEST_MAX_BATCH_BYTES },
      ],
    }),
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({ pinoHttp: buildPinoHttpOptions(config.LOG_LEVEL) }),
    }),
    HealthModule,
    DbModule,
    // The API only enqueues; the worker process (src/worker.ts) runs the handlers.
    JobsModule.forRoot({ work: false }),
    AuthModule,
    KeysModule,
    IntegrationsModule,
    DiagnosticsModule,
    DeletionsModule,
    EventsModule,
    ActivityModule,
    EndpointsModule,
    SettingsModule,
    IngestModule,
    PairingModule,
    RulesModule,
    RetentionModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    // Validates any parameter typed as a nestjs-zod DTO; failures are 400 request.invalid.
    { provide: APP_PIPE, useClass: RequestValidationPipe },
  ],
})
export class AppModule {}
