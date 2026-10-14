import { Module } from "@nestjs/common";
import { APP_FILTER, APP_PIPE } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";
import type { AppConfig } from "./config/config";
import { APP_CONFIG, ConfigModule } from "./config/config.module";
import { isAuthPath } from "./modules/auth/auth.http";
import { AuthModule } from "./modules/auth/auth.module";
import { IntegrationsModule } from "./modules/integrations/integrations.module";
import { KeysModule } from "./modules/keys/keys.module";
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
    // Better Auth's, which needs the raw stream.
    BodyParserModule.forRoot({ skip: isAuthPath }),
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
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    // Validates any parameter typed as a nestjs-zod DTO; failures are 400 request.invalid.
    { provide: APP_PIPE, useClass: RequestValidationPipe },
  ],
})
export class AppModule {}
