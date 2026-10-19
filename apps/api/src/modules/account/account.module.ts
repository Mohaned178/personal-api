import { Module } from "@nestjs/common";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { RateLimiter } from "../../platform/rate-limit/rate-limiter";
import { AuthModule } from "../auth/auth.module";
import {
  ACCOUNT_DELETE_ATTEMPTS_PER_WINDOW,
  ACCOUNT_DELETE_WINDOW_MS,
  ACCOUNT_RATE_LIMITER,
} from "./account.constants";
import { AccountController } from "./account.controller";
import { AccountRepository } from "./account.repository";
import { AccountService } from "./account.service";
import { AccountDeletionSteps } from "./account.steps";

/**
 * Account deletion (`DELETE /v1/account`). A module that keeps user data outside the database
 * registers an `AccountDeletionStep` with `AccountDeletionSteps` (M6-05: export files).
 */
@Module({
  imports: [AuthModule],
  controllers: [AccountController],
  providers: [
    AccountRepository,
    AccountService,
    AccountDeletionSteps,
    {
      provide: ACCOUNT_RATE_LIMITER,
      inject: [CLOCK],
      useFactory: (clock: Clock) =>
        new RateLimiter(
          { limit: ACCOUNT_DELETE_ATTEMPTS_PER_WINDOW, windowMs: ACCOUNT_DELETE_WINDOW_MS },
          clock,
        ),
    },
  ],
  exports: [AccountDeletionSteps],
})
export class AccountModule {}
