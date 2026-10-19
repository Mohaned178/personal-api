import { Inject, Injectable } from "@nestjs/common";
import type { ReadKeyRestriction } from "@personal-api/contracts";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { apiKeys, integrations } from "../../platform/db/schema";
import { scopeCondition, tenantScope } from "../../platform/db/tenant-scope";
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
  /** Raw stored JSON: the caller parses it and refuses the key if it does not parse. */
  scopes: unknown;
  restriction: unknown;
}

export type ReadKeyRow = typeof apiKeys.$inferSelect;

export interface NewReadKey {
  name: string | null;
  prefix: string;
  /** SHA-256 of the plaintext key. The plaintext never reaches this layer. */
  hash: string;
  scopes: string[];
  restriction: ReadKeyRestriction | null;
}

export interface NewIngestKey {
  integrationId: string;
  prefix: string;
  /** SHA-256 of the plaintext key. The plaintext never reaches this layer. */
  hash: string;
}

/**
 * Every public method takes `userId` as its FIRST argument and goes through `tenantScope`, so it
 * rejects with `MissingUserScopeError` (before touching the database) when it is missing or
 * blank. The single exception is `findByHash`, the pre-auth lookup: it is how we find out who the
 * caller is. Keep helpers out of the class (or prefix them with `_`): the scoping test walks the
 * prototype.
 */
@Injectable()
export class ApiKeysRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * The only deliberately unscoped query. Looks up by SHA-256 hash, never by plaintext. The join
   * only matches an integration owned by the key's own user, so a mismatched row reads as "no
   * integration" and fails closed.
   */
  async findByHash(hash: string): Promise<ApiKeyLookupRow | null> {
    const [row] = await this.db
      .select({
        id: apiKeys.id,
        userId: apiKeys.userId,
        kind: apiKeys.kind,
        integrationId: apiKeys.integrationId,
        revokedAt: apiKeys.revokedAt,
        lastUsedAt: apiKeys.lastUsedAt,
        integrationStatus: integrations.status,
        scopes: apiKeys.scopes,
        restriction: apiKeys.restriction,
      })
      .from(apiKeys)
      .leftJoin(
        integrations,
        and(eq(integrations.id, apiKeys.integrationId), eq(integrations.userId, apiKeys.userId)),
      )
      .where(eq(apiKeys.hash, hash))
      .limit(1);
    return row ? { ...row, kind: row.kind as ApiKeyKind } : null;
  }

  /**
   * Stores an ingest key for one of the user's active integrations. Returns null (and stores
   * nothing) when the integration is unknown, revoked or someone else's.
   *
   * The integration row is read FOR SHARE inside a transaction, so a concurrent revoke (which
   * UPDATEs that row first, see IntegrationsRepository.revoke) either waits for this insert and
   * then revokes the new key too, or commits first and makes this return null. A key can never be
   * added to an integration after its revocation. This select is the one query here that does not
   * go through `scope.select` (it has no lock option); it still ANDs the user scope via
   * `scopeCondition`.
   */
  async insertIngestKey(userId: string, values: NewIngestKey): Promise<{ id: string } | null> {
    // Built first, so a missing userId rejects before the database is touched.
    tenantScope(this.db, userId);
    return this.db.transaction(async (tx) => {
      const [integration] = await tx
        .select({ id: integrations.id })
        .from(integrations)
        .where(
          scopeCondition(
            integrations,
            userId,
            and(eq(integrations.id, values.integrationId), eq(integrations.status, "active")),
          ),
        )
        .for("share");
      if (!integration) return null;
      const [row] = await tenantScope(tx, userId).insert(apiKeys, {
        kind: "ingest",
        integrationId: integration.id,
        prefix: values.prefix,
        hash: values.hash,
      });
      return row ? { id: row.id } : null;
    });
  }

  /**
   * Stores a read key. Returns null (and stores nothing) when the restriction names a source that
   * is not one of the user's integrations; an unknown id and someone else's look the same.
   */
  async insertReadKey(userId: string, values: NewReadKey): Promise<ReadKeyRow | null> {
    // Built first, so a missing userId rejects before the database is touched.
    tenantScope(this.db, userId);
    return this.db.transaction(async (tx) => {
      const sources = values.restriction?.sources;
      if (sources && sources.length > 0) {
        const owned = await tx
          .select({ id: integrations.id })
          .from(integrations)
          .where(scopeCondition(integrations, userId, inArray(integrations.id, sources)));
        if (owned.length !== new Set(sources).size) return null;
      }
      const [row] = await tenantScope(tx, userId).insert(apiKeys, {
        kind: "read",
        name: values.name,
        prefix: values.prefix,
        hash: values.hash,
        scopes: values.scopes,
        restriction: values.restriction,
      });
      return row ?? null;
    });
  }

  /** The user's read keys (revoked ones included). Ingest keys belong to integrations and are not listed. */
  async listReadKeys(userId: string): Promise<ReadKeyRow[]> {
    return tenantScope(this.db, userId).select(apiKeys, eq(apiKeys.kind, "read"));
  }

  /**
   * Sets revoked_at on one of the user's read keys, keeping the first revocation time. Returns the
   * key, or null when it is unknown, not the user's, or not a read key.
   */
  async revokeReadKey(userId: string, keyId: string, at: Date): Promise<ReadKeyRow | null> {
    const [row] = await tenantScope(this.db, userId).update(
      apiKeys,
      { revokedAt: sql`coalesce(${apiKeys.revokedAt}, ${sql.param(at, apiKeys.revokedAt)})` },
      and(eq(apiKeys.id, keyId), eq(apiKeys.kind, "read")),
    );
    return row ?? null;
  }

  /**
   * Sets revoked_at, keeping the first revocation time if the key was already revoked. Returns
   * false when the key is unknown or not the user's.
   */
  async revoke(userId: string, keyId: string, at: Date): Promise<boolean> {
    const rows = await tenantScope(this.db, userId).update(
      apiKeys,
      { revokedAt: sql`coalesce(${apiKeys.revokedAt}, ${sql.param(at, apiKeys.revokedAt)})` },
      eq(apiKeys.id, keyId),
    );
    return rows.length > 0;
  }

  /**
   * Sets last_used_at to `at` unless it was already set within `intervalMs` before `at`, or the
   * key is revoked. The condition is in the UPDATE itself, so concurrent requests write once.
   */
  async touchLastUsed(
    userId: string,
    keyId: string,
    at: Date,
    intervalMs: number,
  ): Promise<boolean> {
    const scope = tenantScope(this.db, userId);
    const staleAtOrBefore = new Date(at.getTime() - intervalMs);
    const rows = await scope.update(
      apiKeys,
      { lastUsedAt: at },
      and(
        eq(apiKeys.id, keyId),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.lastUsedAt), lte(apiKeys.lastUsedAt, staleAtOrBefore)),
      ),
    );
    return rows.length > 0;
  }
}
