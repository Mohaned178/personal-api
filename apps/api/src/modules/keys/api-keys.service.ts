import { Inject, Injectable } from "@nestjs/common";
import { INTEGRATION_NOT_FOUND_CODE } from "@personal-api/contracts";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { isUuid } from "../../platform/db/uuid";
import { AppException } from "../../platform/errors/problem";
import type { IngestAuthContext } from "../auth/auth-context";
import { type ApiKeyLookupRow, ApiKeysRepository } from "./api-keys.repository";
import { generateApiKey, hashApiKey, INGEST_KEY_PATTERN } from "./key-generation";

/** last_used_at is written at most once per this interval per key. */
export const LAST_USED_UPDATE_INTERVAL_MS = 60_000;

export interface CreatedApiKey {
  id: string;
  /** The plaintext key. Returned here once and never stored. */
  key: string;
  prefix: string;
}

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly repository: ApiKeysRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Creates an ingest key for an active integration the user owns. Rejects (and stores nothing)
   * when the integration does not exist, is revoked or belongs to another user. Only the hash and
   * the display prefix are stored; the plaintext is returned once.
   */
  async createIngestKey(userId: string, integrationId: string): Promise<CreatedApiKey> {
    assertUserScope(userId);
    if (!isUuid(integrationId)) throw integrationNotFound();
    const key = generateApiKey();
    const row = await this.repository.insertIngestKey(userId, {
      integrationId,
      prefix: key.prefix,
      hash: key.hash,
    });
    if (!row) throw integrationNotFound();
    return { id: row.id, key: key.plaintext, prefix: key.prefix };
  }

  /**
   * Sets revoked_at (clock time; a second revoke keeps the first time). Returns false when the key
   * is not the user's, or unknown.
   */
  async revokeKey(userId: string, keyId: string): Promise<boolean> {
    assertUserScope(userId);
    if (!isUuid(keyId)) return false;
    return this.repository.revoke(userId, keyId, this.clock.now());
  }

  /**
   * Resolves a presented bearer token to an ingest AuthContext, or null for anything else:
   * unknown, malformed, revoked, or a revoked integration. Never throws for bad input (a database
   * failure still throws, so it surfaces as a 500, not as a bad key). Bumps last_used_at
   * (throttled) on success only.
   */
  async authenticateIngestKey(presented: string | undefined): Promise<IngestAuthContext | null> {
    if (typeof presented !== "string" || !INGEST_KEY_PATTERN.test(presented)) return null;
    const row = await this.repository.findByHash(hashApiKey(presented));
    if (
      row?.kind !== "ingest" ||
      row.revokedAt !== null ||
      row.integrationId === null ||
      row.integrationStatus !== "active"
    ) {
      return null;
    }

    await this.touchLastUsed(row);
    return { kind: "ingest", userId: row.userId, integrationId: row.integrationId, keyId: row.id };
  }

  private async touchLastUsed(row: ApiKeyLookupRow): Promise<void> {
    const now = this.clock.now();
    if (
      row.lastUsedAt === null ||
      now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_UPDATE_INTERVAL_MS
    ) {
      await this.repository.touchLastUsed(row.userId, row.id, now, LAST_USED_UPDATE_INTERVAL_MS);
    }
  }
}

function integrationNotFound(): AppException {
  return new AppException(404, INTEGRATION_NOT_FOUND_CODE, "Integration not found");
}
