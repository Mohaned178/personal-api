import { Inject, Injectable } from "@nestjs/common";
import {
  SCHEDULES_PER_USER_MAX,
  type Schedule,
  type ScheduleSave,
  scheduleSchema,
} from "@personal-api/contracts";
import { eq } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { siteSchedules, user } from "../../platform/db/schema";
import { tenantScope } from "../../platform/db/tenant-scope";

type ScheduleRow = typeof siteSchedules.$inferSelect;

/** Why a change was refused. Nothing was written. */
export type ScheduleChangeRefusal = "not_found" | "limit_reached";

export type ScheduleChangeResult = Schedule | ScheduleChangeRefusal;

function toColumns(save: ScheduleSave) {
  const { start, end, ...rest } = save;
  return { ...rest, startTime: start, endTime: end };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every public method takes `userId` as its FIRST argument and goes through `tenantScope`, so a
 * missing or blank userId rejects with `MissingUserScopeError` before the database is touched.
 * Keep helpers out of the class (or prefix them with `_`): the scoping spec walks the prototype.
 */
@Injectable()
export class SchedulesRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** The user's schedules, by name. `enabledOnly` is what the extension config carries. */
  async list(userId: string, enabledOnly = false): Promise<Schedule[]> {
    const rows = await tenantScope(this.db, userId).select(
      siteSchedules,
      enabledOnly ? eq(siteSchedules.enabled, true) : undefined,
    );
    return rows
      .map(toSchedule)
      .sort((a, b) => (a.name === b.name ? cmp(a.id, b.id) : cmp(a.name, b.name)));
  }

  /**
   * Adds a schedule. The user's row is locked first, so two requests cannot both pass the count: the
   * extension would refuse a config with more than `SCHEDULES_PER_USER_MAX` schedules.
   */
  async create(userId: string, save: ScheduleSave, at: Date): Promise<ScheduleChangeResult> {
    tenantScope(this.db, userId);
    return this.db.transaction(async (tx) => {
      await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
      const scope = tenantScope(tx, userId);
      if ((await scope.select(siteSchedules)).length >= SCHEDULES_PER_USER_MAX) {
        return "limit_reached" as const;
      }
      const [row] = await scope.insert(siteSchedules, {
        ...toColumns(save),
        createdAt: at,
        updatedAt: at,
      });
      if (!row) throw new Error("schedule insert returned no row");
      return toSchedule(row);
    });
  }

  /** Replaces the whole schedule. An id that is not the user's is `not_found`. */
  async replace(
    userId: string,
    id: string,
    save: ScheduleSave,
    at: Date,
  ): Promise<ScheduleChangeResult> {
    const [row] = await tenantScope(this.db, userId).update(
      siteSchedules,
      { ...toColumns(save), updatedAt: at },
      eq(siteSchedules.id, id),
    );
    return row ? toSchedule(row) : "not_found";
  }

  /** True when the user had that schedule. */
  async remove(userId: string, id: string): Promise<boolean> {
    const rows = await tenantScope(this.db, userId).delete(siteSchedules, eq(siteSchedules.id, id));
    return rows.length > 0;
  }
}

/**
 * Parsed again on the way out: a stored row that no longer fits the schema is a 500, never a
 * schedule the dashboard or the extension would run in a different shape.
 */
function toSchedule(row: ScheduleRow): Schedule {
  return scheduleSchema.parse({
    id: row.id,
    name: row.name,
    patterns: row.patterns,
    days: row.days,
    start: row.startTime,
    end: row.endTime,
    enabled: row.enabled,
  });
}
