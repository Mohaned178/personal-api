import { Inject, Injectable } from "@nestjs/common";
import { ENDPOINTS_PER_USER_MAX, endpointScope } from "@personal-api/contracts";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { apiKeys, endpoints } from "../../platform/db/schema";
import { type TenantScope, tenantScope } from "../../platform/db/tenant-scope";

export type EndpointRow = typeof endpoints.$inferSelect;

/** What a key insert needs: only the hash and the display prefix are stored. */
export interface NewEndpointKey {
  prefix: string;
  hash: string;
}

export interface EndpointValues {
  slug: string;
  enabled: boolean;
  definition: unknown;
}

/** Why a change was refused. Nothing was written. */
export type EndpointRefusal = "not_found" | "slug_taken" | "limit_reached";

/** Postgres `unique_violation`; the driver error may be wrapped by the ORM as `cause`. */
function isUniqueViolation(error: unknown): boolean {
  for (
    let e = error as { code?: unknown; cause?: unknown } | undefined, depth = 0;
    e && depth < 3;
    depth++
  ) {
    if (e.code === "23505") return true;
    e = e.cause as typeof e;
  }
  return false;
}

/**
 * Every public method takes `userId` as its FIRST argument and goes through `tenantScope`, so a
 * missing or blank userId rejects with `MissingUserScopeError` before the database is touched.
 * Keep helpers out of the class (or prefix them with `_`): the scoping spec walks the prototype.
 *
 * The keys of an endpoint (read keys with `endpoint_id` set and scope `endpoint:<id>`) are written
 * in the same transaction as the endpoint, so an endpoint never exists without its first key, and
 * a rotation never leaves two active keys.
 */
@Injectable()
export class EndpointsRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(userId: string): Promise<EndpointRow[]> {
    const rows = await tenantScope(this.db, userId).select(endpoints);
    return rows.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  }

  async findById(userId: string, id: string): Promise<EndpointRow | null> {
    const [row] = await tenantScope(this.db, userId).select(endpoints, eq(endpoints.id, id));
    return row ?? null;
  }

  async findBySlug(userId: string, slug: string): Promise<EndpointRow | null> {
    const [row] = await tenantScope(this.db, userId).select(endpoints, eq(endpoints.slug, slug));
    return row ?? null;
  }

  async create(
    userId: string,
    values: EndpointValues,
    key: NewEndpointKey,
    at: Date,
  ): Promise<EndpointRow | "slug_taken" | "limit_reached"> {
    tenantScope(this.db, userId);
    try {
      return await this.db.transaction(async (tx) => {
        const scope = tenantScope(tx, userId);
        // The count is not locked: two simultaneous creates at the limit can overshoot by one.
        if ((await scope.select(endpoints)).length >= ENDPOINTS_PER_USER_MAX) {
          return "limit_reached" as const;
        }
        const [row] = await scope.insert(endpoints, { ...values, createdAt: at, updatedAt: at });
        if (!row) throw new Error("endpoint insert returned no row");
        await insertKey(scope, row.id, key);
        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error)) return "slug_taken";
      throw error;
    }
  }

  async replace(
    userId: string,
    id: string,
    values: EndpointValues,
    at: Date,
  ): Promise<EndpointRow | "not_found" | "slug_taken"> {
    try {
      const [row] = await tenantScope(this.db, userId).update(
        endpoints,
        { ...values, updatedAt: at },
        eq(endpoints.id, id),
      );
      return row ?? "not_found";
    } catch (error) {
      if (isUniqueViolation(error)) return "slug_taken";
      throw error;
    }
  }

  /** Deleting the endpoint deletes its keys too (ON DELETE CASCADE). */
  async remove(userId: string, id: string): Promise<EndpointRow | null> {
    const [row] = await tenantScope(this.db, userId).delete(endpoints, eq(endpoints.id, id));
    return row ?? null;
  }

  /** Revokes the endpoint's active keys and stores a new one. Null when the endpoint is not the user's. */
  async rotateKey(
    userId: string,
    id: string,
    key: NewEndpointKey,
    at: Date,
  ): Promise<EndpointRow | null> {
    tenantScope(this.db, userId);
    return this.db.transaction(async (tx) => {
      const scope = tenantScope(tx, userId);
      const [row] = await scope.select(endpoints, eq(endpoints.id, id));
      if (!row) return null;
      await scope.update(
        apiKeys,
        { revokedAt: at },
        and(eq(apiKeys.endpointId, id), isNull(apiKeys.revokedAt)),
      );
      await insertKey(scope, id, key);
      return row;
    });
  }
}

async function insertKey(scope: TenantScope, endpointId: string, key: NewEndpointKey) {
  await scope.insert(apiKeys, {
    kind: "read",
    endpointId,
    prefix: key.prefix,
    hash: key.hash,
    scopes: [endpointScope(endpointId)],
  });
}
