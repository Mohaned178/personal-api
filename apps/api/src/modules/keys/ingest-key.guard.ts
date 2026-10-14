import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { ApiKeysService } from "./api-keys.service";

/**
 * M1-03 (test-writer stub). Reads ONLY `Authorization: Bearer pa_ing_...` (never cookies, query,
 * body or other headers). Any failure is the same 401 problem+json, code `auth.invalid_key`.
 * On success sets `req.auth` to the ingest AuthContext.
 */
@Injectable()
export class IngestKeyGuard implements CanActivate {
  constructor(private readonly keys: ApiKeysService) {}

  async canActivate(_context: ExecutionContext): Promise<boolean> {
    void this.keys;
    throw new Error("not implemented: IngestKeyGuard");
  }
}
