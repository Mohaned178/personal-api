import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { AppException } from "../../platform/errors/problem";
import type { AuthenticatedRequest } from "../auth/auth-context";
import { ApiKeysService } from "./api-keys.service";

export const INVALID_KEY_CODE = "auth.invalid_key";

/** `Bearer <b64token>` (RFC 6750 §2.1): one scheme, one space, one token, nothing else. */
const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;

/** The token from an `Authorization: Bearer` header, or undefined for anything else. */
export function bearerToken(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  return BEARER.exec(header)?.[1];
}

/**
 * Requires an ingest key. Reads ONLY `Authorization: Bearer pa_ing_...` (never cookies, query,
 * body or other headers). Every failure is the same 401 problem+json, `auth.invalid_key`, so the
 * response never says why a key was refused. On success sets `req.auth` to the ingest
 * AuthContext. A database failure is not a bad key: it propagates as a 500, so a client retries
 * instead of treating itself as disconnected.
 */
@Injectable()
export class IngestKeyGuard implements CanActivate {
  constructor(private readonly keys: ApiKeysService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(req.headers.authorization);
    const auth = token === undefined ? null : await this.keys.authenticateIngestKey(token);
    if (auth?.kind !== "ingest") {
      throw new AppException(401, INVALID_KEY_CODE, "Invalid API key");
    }
    req.auth = {
      kind: "ingest",
      userId: auth.userId,
      integrationId: auth.integrationId,
      keyId: auth.keyId,
    };
    return true;
  }
}
