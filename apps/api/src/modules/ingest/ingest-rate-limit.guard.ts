import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { INGEST_RATE_LIMITED_CODE } from "@personal-api/contracts";
import type { Response } from "express";
import { AppException } from "../../platform/errors/problem";
import type { RateLimiter } from "../../platform/rate-limit/rate-limiter";
import type { AuthenticatedRequest } from "../auth/auth-context";
import { INGEST_RATE_LIMITER } from "./ingest.tokens";

/**
 * Requests per ingest key per window, for events, config and heartbeat together. The extension
 * flushes about once a minute and fetches rules now and then; this leaves room for a busy retry
 * burst and stops a runaway client or a leaked key.
 */
export const INGEST_REQUESTS_PER_WINDOW = 120;
export const INGEST_WINDOW_MS = 60_000;

/**
 * Throttles ingest routes per key id. Must run after IngestKeyGuard: the key id comes from
 * `req.auth`, so an unauthenticated caller never reaches (or fills) the limiter.
 */
@Injectable()
export class IngestRateLimitGuard implements CanActivate {
  constructor(@Inject(INGEST_RATE_LIMITER) private readonly limiter: RateLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const auth = http.getRequest<AuthenticatedRequest>().auth;
    if (auth?.kind !== "ingest") {
      throw new AppException(401, "auth.invalid_key", "Invalid API key");
    }
    const result = this.limiter.consume(auth.keyId);
    if (result.allowed) return true;
    http
      .getResponse<Response>()
      .setHeader("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
    throw new AppException(429, INGEST_RATE_LIMITED_CODE, "Too many requests for this key");
  }
}
