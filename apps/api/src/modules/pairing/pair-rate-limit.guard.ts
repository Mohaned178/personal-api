import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { PAIRING_RATE_LIMITED_CODE } from "@personal-api/contracts";
import type { Request, Response } from "express";
import { AppException } from "../../platform/errors/problem";
import type { RateLimiter } from "../../platform/rate-limit/rate-limiter";
import { PAIRING_RATE_LIMITER } from "./pairing.tokens";

/** Attempts per client address per window. A person types a code a few times, never 10 a minute. */
export const PAIR_ATTEMPTS_PER_WINDOW = 10;
export const PAIR_WINDOW_MS = 60_000;

/**
 * Throttles `POST /v1/pair` per client address. Every attempt counts, whatever its outcome, and the
 * check runs before the code is looked at, so a throttled caller cannot tell a right guess from a
 * wrong one.
 *
 * The address is Express's `req.ip` and nothing else: `X-Forwarded-For` is only honoured for as
 * many hops as `TRUST_PROXY` says (default 0). With it unset behind a reverse proxy, every client
 * shares one bucket, which is the safe direction. The address is used as an in-memory key and is
 * never logged.
 */
@Injectable()
export class PairRateLimitGuard implements CanActivate {
  constructor(@Inject(PAIRING_RATE_LIMITER) private readonly limiter: RateLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const result = this.limiter.consume(http.getRequest<Request>().ip ?? "unknown");
    if (result.allowed) return true;
    http
      .getResponse<Response>()
      .setHeader("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
    throw new AppException(429, PAIRING_RATE_LIMITED_CODE, "Too many pairing attempts");
  }
}
