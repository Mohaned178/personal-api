import { Inject, Injectable } from "@nestjs/common";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import type { ApiKeyKind } from "./key-generation";

/** What the pre-auth lookup returns: enough for the guard to decide, joined with the integration's status. */
export interface ApiKeyLookupRow {
  id: string;
  userId: string;
  kind: ApiKeyKind;
  integrationId: string | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  integrationStatus: string | null;
}

/**
 * M1-03 (test-writer stub). CONVENTION the tests enforce: every public method takes `userId` as
 * its FIRST argument and rejects with `MissingUserScopeError` (before touching the database) when
 * it is missing or blank. The single exception is `findByHash`, the pre-auth lookup (it is how we
 * find out who the caller is). Method names other than `findByHash` are the builder's choice.
 */
@Injectable()
export class ApiKeysRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** The only deliberately unscoped query. Looks up by SHA-256 hash, never by plaintext. */
  async findByHash(_hash: string): Promise<ApiKeyLookupRow | null> {
    void this.db;
    throw new Error("not implemented: ApiKeysRepository.findByHash");
  }

  async insert(_userId: string, _values: unknown): Promise<unknown> {
    throw new Error("not implemented: ApiKeysRepository.insert");
  }

  async revoke(_userId: string, _keyId: string, _at: Date): Promise<boolean> {
    throw new Error("not implemented: ApiKeysRepository.revoke");
  }

  async touchLastUsed(_userId: string, _keyId: string, _at: Date): Promise<void> {
    throw new Error("not implemented: ApiKeysRepository.touchLastUsed");
  }
}
