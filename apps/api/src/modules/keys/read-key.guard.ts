import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { INSUFFICIENT_SCOPE_CODE, type ReadScope } from "@personal-api/contracts";
import { AppException } from "../../platform/errors/problem";
import type { AuthenticatedRequest } from "../auth/auth-context";
import { ApiKeysService } from "./api-keys.service";
import { bearerToken, INVALID_KEY_CODE } from "./ingest-key.guard";

const READ_SCOPE_METADATA = "pa:read-scope";

/**
 * The scope a route needs from a read key. Every route behind ReadKeyGuard must declare one: the
 * guard refuses to run without it (500, nothing leaked), so a forgotten declaration can never turn
 * into a route any read key can call.
 */
export const RequireReadScope = (scope: ReadScope) => SetMetadata(READ_SCOPE_METADATA, scope);

/**
 * Requires a read key. Reads ONLY `Authorization: Bearer pa_read_...` (never cookies, query, body
 * or other headers). Every authentication failure is the same 401 problem+json, `auth.invalid_key`,
 * as for ingest keys, so a response never says why a key was refused or which kind it was. A valid
 * key without the route's scope is a 403 `auth.insufficient_scope`. On success sets `req.auth` to
 * the read AuthContext. A database failure propagates as a 500, not as a bad key.
 */
@Injectable()
export class ReadKeyGuard implements CanActivate {
  constructor(
    private readonly keys: ApiKeysService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<ReadScope | undefined>(READ_SCOPE_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined) {
      throw new Error("ReadKeyGuard is on a route that declares no @RequireReadScope");
    }

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(req.headers.authorization);
    const auth = token === undefined ? null : await this.keys.authenticateReadKey(token);
    if (auth?.kind !== "read") {
      throw new AppException(401, INVALID_KEY_CODE, "Invalid API key");
    }
    if (!auth.scopes.includes(required)) {
      throw new AppException(403, INSUFFICIENT_SCOPE_CODE, "This key cannot read this resource");
    }
    req.auth = auth;
    return true;
  }
}
