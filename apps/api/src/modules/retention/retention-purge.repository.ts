import { Inject, Injectable } from "@nestjs/common";
import { inArray, lte } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { events } from "../../platform/db/schema";

/**
 * The one place that touches events of every user at once, for the hourly purge. It is on the
 * tenant-scoping allowlist on purpose: a cron job has no AuthContext, and the inputs here are a
 * clock reading and a batch size, never anything a request supplied. It returns counts, never rows
 * (invariants 2 and 6). Anything else that reads or writes events takes a `userId` and goes
 * through the scoped helpers.
 */
@Injectable()
export class RetentionPurgeRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Deletes up to `limit` events with `expires_at <= now`, oldest expiry first, and returns how many.
   * A row without an `expires_at` is never deleted (NULL compares false). `FOR UPDATE SKIP LOCKED`
   * lets two runs, or a run and a recompute, work side by side without waiting on or deadlocking
   * with each other.
   */
  async purgeExpired(now: Date, limit: number): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError("limit must be a positive integer");
    const expired = this.db
      .select({ id: events.id })
      .from(events)
      .where(lte(events.expiresAt, now))
      .orderBy(events.expiresAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    const rows = await this.db
      .delete(events)
      .where(inArray(events.id, expired))
      .returning({ id: events.id });
    return rows.length;
  }
}
