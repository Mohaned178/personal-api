import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import type { AppConfig } from "./config/config";
import { APP_CONFIG, ConfigModule } from "./config/config.module";
import { DeletionsJobsModule } from "./modules/deletions/deletions-jobs.module";
import { ExportsJobsModule } from "./modules/exports/exports-jobs.module";
import { RetentionJobsModule } from "./modules/retention/retention-jobs.module";
import { ClockModule } from "./platform/clock/clock.module";
import { DbModule } from "./platform/db/db.module";
import { HealthModule } from "./platform/health/health.module";
import { JobsModule } from "./platform/jobs/jobs.module";
import { buildPinoHttpOptions } from "./platform/logging/logging";

/**
 * Worker process root. Domain modules that register job handlers are added here, with the
 * `DbModule` and `ClockModule` they need (they are global once imported).
 */
@Module({
  imports: [
    ConfigModule,
    ClockModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({ pinoHttp: buildPinoHttpOptions(config.LOG_LEVEL) }),
    }),
    HealthModule,
    DbModule,
    JobsModule.forRoot({ work: true }),
    RetentionJobsModule,
    DeletionsJobsModule,
    ExportsJobsModule,
  ],
})
export class WorkerModule {}
