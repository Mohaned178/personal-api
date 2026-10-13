import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import type { AppConfig } from "./config/config";
import { APP_CONFIG, ConfigModule } from "./config/config.module";
import { HealthModule } from "./platform/health/health.module";
import { JobsModule } from "./platform/jobs/jobs.module";
import { buildPinoHttpOptions } from "./platform/logging/logging";

/** Worker process root. Domain modules that register job handlers are added here. */
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({ pinoHttp: buildPinoHttpOptions(config.LOG_LEVEL) }),
    }),
    HealthModule,
    JobsModule.forRoot({ work: true }),
  ],
})
export class WorkerModule {}
