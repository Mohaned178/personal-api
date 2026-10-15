import { Module } from "@nestjs/common";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { RateLimiter } from "../../platform/rate-limit/rate-limiter";
import { AuthModule } from "../auth/auth.module";
import {
  PAIR_ATTEMPTS_PER_WINDOW,
  PAIR_WINDOW_MS,
  PairRateLimitGuard,
} from "./pair-rate-limit.guard";
import { PairingController } from "./pairing.controller";
import { PairingRepository } from "./pairing.repository";
import { PairingService } from "./pairing.service";
import { PAIRING_RATE_LIMITER } from "./pairing.tokens";

/**
 * Pairing: `POST /v1/integrations/:id/pairing-code` (session) and `POST /v1/pair` (code, throttled
 * per client address). `CLOCK` comes from the global ClockModule.
 */
@Module({
  imports: [AuthModule],
  controllers: [PairingController],
  providers: [
    PairingRepository,
    PairingService,
    PairRateLimitGuard,
    {
      provide: PAIRING_RATE_LIMITER,
      inject: [CLOCK],
      useFactory: (clock: Clock) =>
        new RateLimiter({ limit: PAIR_ATTEMPTS_PER_WINDOW, windowMs: PAIR_WINDOW_MS }, clock),
    },
  ],
})
export class PairingModule {}
