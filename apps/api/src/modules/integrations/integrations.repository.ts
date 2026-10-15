import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { apiKeys, integrations } from "../../platform/db/schema";
import { tenantScope } from "../../platform/db/tenant-scope";

export type IntegrationRow = typeof integrations.$inferSelect;

export interface NewHttpIntegration {
  name: string;
}

export interface NewBrowserExtensionIntegration {
  name: string;
}

export interface NewIngestKeyValues {
  prefix: string;
  /** SHA-256 of the plaintext key. The plaintext never reaches this layer. */
  hash: string;
}

/**
 * Every method takes `userId` as its FIRST argument and goes through `tenantScope`, so a missing
 * or blank userId rejects with `MissingUserScopeError` before the database is touched, and no
 * query can reach another user's row. Keep helpers out of the class (or prefix them with `_`):
 * the scoping spec walks the prototype.
 *
 * Lock order for anything that touches both tables: the integration row first, then its keys.
 */
@Injectable()
export class IntegrationsRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Creates a deny-by-default `http` integration and its first ingest key in ONE transaction, so
   * an `http` integration is never keyless. (A `browser-extension` one starts without a key on
   * purpose: see `createBrowserExtension`.)
   */
  async createHttp(
    userId: string,
    values: NewHttpIntegration,
    key: NewIngestKeyValues,
  ): Promise<{ integration: IntegrationRow; keyId: string }> {
    // Built first, so a missing userId rejects before the database is touched.
    tenantScope(this.db, userId);
    return this.db.transaction(async (tx) => {
      const scope = tenantScope(tx, userId);
      const [integration] = await scope.insert(integrations, {
        kind: "http",
        name: values.name,
        defaultPolicy: "deny",
      });
      if (!integration) throw new Error("integration insert returned no row");
      const [stored] = await scope.insert(apiKeys, {
        kind: "ingest",
        integrationId: integration.id,
        prefix: key.prefix,
        hash: key.hash,
      });
      if (!stored) throw new Error("api key insert returned no row");
      return { integration, keyId: stored.id };
    });
  }

  /**
   * Creates a deny-by-default `browser-extension` integration with NO key. Its ingest key is
   * issued when the extension redeems a pairing code (PairingRepository.redeem), never earlier.
   */
  async createBrowserExtension(
    userId: string,
    values: NewBrowserExtensionIntegration,
  ): Promise<IntegrationRow> {
    const [integration] = await tenantScope(this.db, userId).insert(integrations, {
      kind: "browser-extension",
      name: values.name,
      defaultPolicy: "deny",
    });
    if (!integration) throw new Error("integration insert returned no row");
    return integration;
  }

  /** Newest first, with the id as the tie-break. A user has a handful of sources: no paging. */
  async list(userId: string): Promise<IntegrationRow[]> {
    const rows = await tenantScope(this.db, userId).select(integrations);
    return rows.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1),
    );
  }

  async findById(userId: string, id: string): Promise<IntegrationRow | null> {
    const [row] = await tenantScope(this.db, userId).select(integrations, eq(integrations.id, id));
    return row ?? null;
  }

  /** Null when the integration is unknown or not the user's. */
  async rename(userId: string, id: string, name: string): Promise<IntegrationRow | null> {
    const [row] = await tenantScope(this.db, userId).update(
      integrations,
      { name },
      eq(integrations.id, id),
    );
    return row ?? null;
  }

  /**
   * Revokes the integration and every key issued for it in ONE transaction: the integration row
   * is updated first (taking its row lock, which waits for an in-flight key insert that holds it
   * FOR SHARE), then the keys, so the keys update also sees that insert's new key. A key already
   * revoked keeps its first revocation time; revoking twice is a no-op. Null when the
   * integration is unknown or not the user's.
   */
  async revoke(userId: string, id: string, at: Date): Promise<IntegrationRow | null> {
    tenantScope(this.db, userId);
    return this.db.transaction(async (tx) => {
      const scope = tenantScope(tx, userId);
      const [integration] = await scope.update(
        integrations,
        { status: "revoked" },
        eq(integrations.id, id),
      );
      if (!integration) return null;
      await scope.update(
        apiKeys,
        { revokedAt: sql`coalesce(${apiKeys.revokedAt}, ${sql.param(at, apiKeys.revokedAt)})` },
        eq(apiKeys.integrationId, id),
      );
      return integration;
    });
  }
}
