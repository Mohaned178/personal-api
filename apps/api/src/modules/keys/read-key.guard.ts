import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  INSUFFICIENT_SCOPE_CODE,
  READ_RATE_LIMITED_CODE,
  type ReadScope,
} from "@personal-api/contracts";
import type { Response } from "express";
import { AppException } from "../../platform/errors/problem";
import type { RateLimiter } from "../../platform/rate-limit/rate-limiter";
import type { AuthenticatedRequest } from "../auth/auth-context";
import { ApiKeysService } from "./api-keys.service";
import { bearerToken, INVALID_KEY_CODE } from "./ingest-key.guard";
import { READ_RATE_LIMITER } from "./keys.tokens";

export const READ_SCOPE_METADATA = "pa:read-scope";

/**
 * Requests per read key per window, over every route the key can call. A saved query may hold a
 * database connection for up to its 2-second timeout, so this also caps how much of the pool one
 * key (an endpoint key may be shared with others) can keep busy: about 4 connections.
 */
export const READ_REQUESTS_PER_WINDOW = 120;
export const READ_WINDOW_MS = 60_000;

/**
 * The scope a route needs from a read key. Every route behind ReadKeyGuard must declare one: the
 * guard refuses to run without it (500, nothing leaked), so a forgotten declaration can never turn
 * into a route any read key can call.
 */
export const RequireReadScope = (scope: ReadScope) => SetMetadata(READ_SCOPE_METADATA, scope);

const ENDPOINT_ROUTE = "endpoint" as const;

/**
 * For `GET /v1/me/:slug`: the scope a key needs is `endpoint:<id>` of the endpoint the slug names,
 * which only the route can look up. The guard still requires a valid read key, and the route MUST
 * check the key's scopes against that endpoint (EndpointsService.runBySlug does, and a test pins it).
 */
export const RequireEndpointScope = () => SetMetadata(READ_SCOPE_METADATA, ENDPOINT_ROUTE);

/**
 * Requires a read key. Reads ONLY `Authorization: Bearer pa_read_...` (never cookies, query, body
 * or other headers). Every authentication failure is the same 401 problem+json, `auth.invalid_key`,
 * as for ingest keys, so a response never says why a key was refused or which kind it was. Every
 * request with a valid key then counts against that key's budget (429 `read.rate_limited` with
 * `Retry-After` past it); a bad key never reaches the limiter. A valid key without the route's
 * scope is a 403 `auth.insufficient_scope`. On success sets `req.auth` to the read AuthContext. A
 * database failure propagates as a 500, not as a bad key.
 */
@Injectable()
export class ReadKeyGuard implements CanActivate {
  constructor(
    private readonly keys: ApiKeysService,
    private readonly reflector: Reflector,
    @Inject(READ_RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<
      ReadScope | typeof ENDPOINT_ROUTE | undefined
    >(READ_SCOPE_METADATA, [context.getHandler(), context.getClass()]);
    if (required === undefined) {
      throw new Error("ReadKeyGuard is on a route that declares no @RequireReadScope");
    }

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(req.headers.authorization);
    const auth = token === undefined ? null : await this.keys.authenticateReadKey(token);
    if (auth?.kind !== "read") {
      throw new AppException(401, INVALID_KEY_CODE, "Invalid API key");
    }
    const budget = this.limiter.consume(auth.keyId);
    if (!budget.allowed) {
      context
        .switchToHttp()
        .getResponse<Response>()
        .setHeader("Retry-After", String(Math.ceil(budget.retryAfterMs / 1000)));
      throw new AppException(429, READ_RATE_LIMITED_CODE, "Too many requests for this key");
    }
    if (required !== ENDPOINT_ROUTE && !auth.scopes.includes(required)) {
      throw new AppException(403, INSUFFICIENT_SCOPE_CODE, "This key cannot read this resource");
    }
    req.auth = auth;
    return true;
  }
}
