import { Inject, Injectable } from "@nestjs/common";
import {
  LIMITS_PER_USER_MAX,
  type Limit,
  type LimitSave,
  limitSchema,
} from "@personal-api/contracts";
import { eq } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { hasPgErrorCode, PG_UNIQUE_VIOLATION } from "../../platform/db/pg-error";
import { siteLimits, user } from "../../platform/db/schema";
import { tenantScope } from "../../platform/db/tenant-scope";

type LimitRow = typeof siteLimits.$inferSelect;

/** Why a change was refused. Nothing was written. */
export type LimitChangeRefusal = "not_found" | "limit_reached" | "pattern_taken";

export type LimitChangeResult = Limit | LimitChangeRefusal;

/**
 * Every public method takes `userId` as its FIRST argument and goes through `tenantScope`, so a
 * missing or blank userId rejects with `MissingUserScopeError` before the database is touched.
 * Keep helpers out of the class (or prefix them with `_`): the scoping spec walks the prototype.
 */
@Injectable()
export class LimitsRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** The user's limits, by pattern. */
  async list(userId: string): Promise<Limit[]> {
    const rows = await tenantScope(this.db, userId).select(siteLimits);
    return rows.map(toLimit).sort((a, b) => (a.pattern < b.pattern ? -1 : 1));
  }

  /**
   * Adds a limit. The user's row is locked first, so two requests cannot both pass the count: the
   * extension would refuse a config with more than `LIMITS_PER_USER_MAX` limits and collect nothing.
   */
  async create(userId: string, save: LimitSave, at: Date): Promise<LimitChangeResult> {
    tenantScope(this.db, userId);
    try {
      return await this.db.transaction(async (tx) => {
        await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
        const scope = tenantScope(tx, userId);
        if ((await scope.select(siteLimits)).length >= LIMITS_PER_USER_MAX) {
          return "limit_reached" as const;
        }
        const [row] = await scope.insert(siteLimits, { ...save, createdAt: at, updatedAt: at });
        if (!row) throw new Error("limit insert returned no row");
        return toLimit(row);
      });
    } catch (error) {
      if (hasPgErrorCode(error, PG_UNIQUE_VIOLATION)) return "pattern_taken";
      throw error;
    }
  }

  /** Replaces the whole limit. An id that is not the user's is `not_found`. */
  async replace(userId: string, id: string, save: LimitSave, at: Date): Promise<LimitChangeResult> {
    const scope = tenantScope(this.db, userId);
    try {
      const [row] = await scope.update(
        siteLimits,
        { ...save, updatedAt: at },
        eq(siteLimits.id, id),
      );
      return row ? toLimit(row) : "not_found";
    } catch (error) {
      if (hasPgErrorCode(error, PG_UNIQUE_VIOLATION)) return "pattern_taken";
      throw error;
    }
  }

  /** True when the user had that limit. */
  async remove(userId: string, id: string): Promise<boolean> {
    const rows = await tenantScope(this.db, userId).delete(siteLimits, eq(siteLimits.id, id));
    return rows.length > 0;
  }
}

/**
 * Parsed again on the way out: a stored row that no longer fits the schema is a 500, never a limit
 * the dashboard or the extension would run in a different shape.
 */
function toLimit(row: LimitRow): Limit {
  return limitSchema.parse({
    id: row.id,
    pattern: row.pattern,
    minutes: row.minutes,
    strict: row.strict,
  });
}
