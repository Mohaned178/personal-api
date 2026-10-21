import { Inject, Injectable } from "@nestjs/common";
import { type Goal, type GoalCategory, goalSchema } from "@personal-api/contracts";
import { eq } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { hasPgErrorCode, PG_UNIQUE_VIOLATION } from "../../platform/db/pg-error";
import { categoryGoals } from "../../platform/db/schema";
import { tenantScope } from "../../platform/db/tenant-scope";

type GoalRow = typeof categoryGoals.$inferSelect;

/**
 * Every public method takes `userId` as its FIRST argument and goes through `tenantScope`, so a
 * missing or blank userId rejects with `MissingUserScopeError` before the database is touched.
 * Keep helpers out of the class (or prefix them with `_`): the scoping spec walks the prototype.
 */
@Injectable()
export class GoalsRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** The user's goals, by category. */
  async list(userId: string): Promise<Goal[]> {
    const rows = await tenantScope(this.db, userId).select(categoryGoals);
    return rows.map(toGoal).sort((a, b) => (a.category < b.category ? -1 : 1));
  }

  /** Sets the goal of a category, replacing the one it had. */
  async put(userId: string, category: GoalCategory, minutes: number, at: Date): Promise<Goal> {
    const scope = tenantScope(this.db, userId);
    const where = eq(categoryGoals.category, category);
    const [updated] = await scope.update(categoryGoals, { minutes, updatedAt: at }, where);
    if (updated) return toGoal(updated);
    try {
      const [row] = await scope.insert(categoryGoals, {
        category,
        minutes,
        createdAt: at,
        updatedAt: at,
      });
      if (!row) throw new Error("goal insert returned no row");
      return toGoal(row);
    } catch (error) {
      // A concurrent request created it first: ours is the later write.
      if (!hasPgErrorCode(error, PG_UNIQUE_VIOLATION)) throw error;
      const [row] = await scope.update(categoryGoals, { minutes, updatedAt: at }, where);
      if (!row) throw error;
      return toGoal(row);
    }
  }

  /** True when the user had a goal for that category. */
  async remove(userId: string, category: GoalCategory): Promise<boolean> {
    const rows = await tenantScope(this.db, userId).delete(
      categoryGoals,
      eq(categoryGoals.category, category),
    );
    return rows.length > 0;
  }
}

/** Parsed again on the way out: a stored row that no longer fits the schema is a 500. */
function toGoal(row: GoalRow): Goal {
  return goalSchema.parse({ category: row.category, minutes: row.minutes });
}
