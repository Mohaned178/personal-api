import { Inject, Injectable } from "@nestjs/common";
import {
  CATEGORY_RULES_PER_USER_MAX,
  type CategoryRule,
  type CategoryRuleSave,
  categoryRuleSchema,
} from "@personal-api/contracts";
import { eq } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { hasPgErrorCode, PG_UNIQUE_VIOLATION } from "../../platform/db/pg-error";
import { siteCategories, user } from "../../platform/db/schema";
import { tenantScope } from "../../platform/db/tenant-scope";

type CategoryRow = typeof siteCategories.$inferSelect;

/** Why a change was refused. Nothing was written. */
export type CategoryChangeRefusal = "not_found" | "limit_reached" | "pattern_taken";

export type CategoryChangeResult = CategoryRule | CategoryChangeRefusal;

/**
 * Every public method takes `userId` as its FIRST argument and goes through `tenantScope`, so a
 * missing or blank userId rejects with `MissingUserScopeError` before the database is touched.
 * Keep helpers out of the class (or prefix them with `_`): the scoping spec walks the prototype.
 */
@Injectable()
export class CategoriesRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** The user's overrides, by pattern. */
  async list(userId: string): Promise<CategoryRule[]> {
    const rows = await tenantScope(this.db, userId).select(siteCategories);
    return rows.map(toRule).sort((a, b) => (a.pattern < b.pattern ? -1 : 1));
  }

  /** Adds an override. The user row is locked first, so two requests cannot both pass the count. */
  async create(userId: string, save: CategoryRuleSave, at: Date): Promise<CategoryChangeResult> {
    tenantScope(this.db, userId);
    try {
      return await this.db.transaction(async (tx) => {
        await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
        const scope = tenantScope(tx, userId);
        if ((await scope.select(siteCategories)).length >= CATEGORY_RULES_PER_USER_MAX) {
          return "limit_reached" as const;
        }
        const [row] = await scope.insert(siteCategories, {
          ...save,
          createdAt: at,
          updatedAt: at,
        });
        if (!row) throw new Error("category insert returned no row");
        return toRule(row);
      });
    } catch (error) {
      if (hasPgErrorCode(error, PG_UNIQUE_VIOLATION)) return "pattern_taken";
      throw error;
    }
  }

  /** Replaces the whole override. An id that is not the user's is `not_found`. */
  async replace(
    userId: string,
    id: string,
    save: CategoryRuleSave,
    at: Date,
  ): Promise<CategoryChangeResult> {
    const scope = tenantScope(this.db, userId);
    try {
      const [row] = await scope.update(
        siteCategories,
        { ...save, updatedAt: at },
        eq(siteCategories.id, id),
      );
      return row ? toRule(row) : "not_found";
    } catch (error) {
      if (hasPgErrorCode(error, PG_UNIQUE_VIOLATION)) return "pattern_taken";
      throw error;
    }
  }

  /** True when the user had that override. */
  async remove(userId: string, id: string): Promise<boolean> {
    const rows = await tenantScope(this.db, userId).delete(
      siteCategories,
      eq(siteCategories.id, id),
    );
    return rows.length > 0;
  }
}

/** Parsed again on the way out: a stored row that no longer fits the schema is a 500. */
function toRule(row: CategoryRow): CategoryRule {
  return categoryRuleSchema.parse({ id: row.id, pattern: row.pattern, category: row.category });
}
