import { Module } from "@nestjs/common";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { RateLimiter } from "../../platform/rate-limit/rate-limiter";
import { AuthModule } from "../auth/auth.module";
import { ApiKeysRepository } from "./api-keys.repository";
import { ApiKeysService } from "./api-keys.service";
import { IngestKeyGuard } from "./ingest-key.guard";
import { KeysController } from "./keys.controller";
import { READ_RATE_LIMITER } from "./keys.tokens";
import { READ_REQUESTS_PER_WINDOW, READ_WINDOW_MS, ReadKeyGuard } from "./read-key.guard";
import { SessionOrReadKeyGuard } from "./session-or-read-key.guard";

/**
 * API keys: generation, hashed storage, ingest-key and read-key authentication, IngestKeyGuard
 * and ReadKeyGuard, and the session routes for read keys (`/v1/keys`). A module whose controllers
 * use `@UseGuards(IngestKeyGuard)` or `@UseGuards(ReadKeyGuard)` imports this one. `CLOCK` comes
 * from the global ClockModule.
 *
 * The read-key limiter is exported too: Nest builds a `@UseGuards(ReadKeyGuard)` guard in each
 * controller's own module, and every one of them must resolve this one limiter, so a key has one
 * budget across every read route.
 */
@Module({
  imports: [AuthModule],
  controllers: [KeysController],
  providers: [
    ApiKeysRepository,
    ApiKeysService,
    IngestKeyGuard,
    ReadKeyGuard,
    SessionOrReadKeyGuard,
    {
      provide: READ_RATE_LIMITER,
      inject: [CLOCK],
      useFactory: (clock: Clock) =>
        new RateLimiter({ limit: READ_REQUESTS_PER_WINDOW, windowMs: READ_WINDOW_MS }, clock),
    },
  ],
  exports: [ApiKeysService, IngestKeyGuard, ReadKeyGuard, SessionOrReadKeyGuard, READ_RATE_LIMITER],
})
export class KeysModule {}
