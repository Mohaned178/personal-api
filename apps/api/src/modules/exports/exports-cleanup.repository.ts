import { Inject, Injectable } from "@nestjs/common";
import { and, inArray, isNull, lte, or } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { exports as exportsTable } from "../../platform/db/schema";

/**
 * The hourly cleanup touches exports of every user at once. A cron job has no AuthContext, so this
 * is on the exception to the scoped helpers on purpose, like `RetentionPurgeRepository`: its inputs
 * are a clock reading, row ids it read itself and a batch size, never anything a request supplied,
 * and it returns ids, never filters or paths. `exports-cleanup.repository.spec.ts` pins its methods.
 */
@Injectable()
export class ExportsCleanupRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Ids of exports whose download window has closed (`expires_at <= now`), plus those that never
   * completed and are older than `staleBefore` (failed, or stuck).
   */
  async findDue(now: Date, staleBefore: Date, limit: number): Promise<string[]> {
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError("limit must be a positive integer");
    const rows = await this.db
      .select({ id: exportsTable.id })
      .from(exportsTable)
      .where(
        or(
          lte(exportsTable.expiresAt, now),
          and(isNull(exportsTable.expiresAt), lte(exportsTable.createdAt, staleBefore)),
        ),
      )
      .orderBy(exportsTable.createdAt)
      .limit(limit);
    return rows.map((row) => row.id);
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.delete(exportsTable).where(inArray(exportsTable.id, ids));
  }

  /** Which of these ids still have a row. */
  async existing(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: exportsTable.id })
      .from(exportsTable)
      .where(inArray(exportsTable.id, ids));
    return rows.map((row) => row.id);
  }
}
