import { Module } from "@nestjs/common";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { RateLimiter } from "../../platform/rate-limit/rate-limiter";
import { FocusModule } from "../focus/focus.module";
import { KeysModule } from "../keys/keys.module";
import { LimitsModule } from "../limits/limits.module";
import { RetentionModule } from "../retention/retention.module";
import { RulesModule } from "../rules/rules.module";
import { SchedulesModule } from "../schedules/schedules.module";
import { IngestController } from "./ingest.controller";
import { IngestRepository } from "./ingest.repository";
import { IngestService } from "./ingest.service";
import { INGEST_RATE_LIMITER } from "./ingest.tokens";
import {
  INGEST_REQUESTS_PER_WINDOW,
  INGEST_WINDOW_MS,
  IngestRateLimitGuard,
} from "./ingest-rate-limit.guard";

/**
 * `POST /v1/ingest/events`: per-item validation, the user's rules, storage with dedupe, hourly counters. The 256 KB
 * body limit for its route is set where the body parser is configured (AppModule). `CLOCK` comes
 * from the global ClockModule.
 */
@Module({
  imports: [KeysModule, RulesModule, RetentionModule, LimitsModule, FocusModule, SchedulesModule],
  controllers: [IngestController],
  providers: [
    IngestRepository,
    IngestService,
    IngestRateLimitGuard,
    {
      provide: INGEST_RATE_LIMITER,
      inject: [CLOCK],
      useFactory: (clock: Clock) =>
        new RateLimiter({ limit: INGEST_REQUESTS_PER_WINDOW, windowMs: INGEST_WINDOW_MS }, clock),
    },
  ],
})
export class IngestModule {}
