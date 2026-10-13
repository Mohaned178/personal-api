import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";
import type { AppConfig } from "./config/config";
import { APP_CONFIG, ConfigModule } from "./config/config.module";
import { ProblemFilter } from "./platform/errors/problem.filter";
import { HealthModule } from "./platform/health/health.module";
import { buildPinoHttpOptions } from "./platform/logging/logging";

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({ pinoHttp: buildPinoHttpOptions(config.LOG_LEVEL) }),
    }),
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
})
export class AppModule {}
