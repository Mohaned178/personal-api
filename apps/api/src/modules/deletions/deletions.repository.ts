import { Inject, Injectable } from "@nestjs/common";
import type { DeletionFilter } from "@personal-api/contracts";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { bulkDeletions, events } from "../../platform/db/schema";
import { assertUserScope, scopeCondition, tenantScope } from "../../platform/db/tenant-scope";
import { eventFilterConditions, toEventFilters } from "../events/events.repository";

export type DeletionRow = typeof bulkDeletions.$inferSelect;

/**
 * Every method takes `userId` as its FIRST argument and ANDs it onto the query through the tenant
 * helpers, so no query can reach another user's row. Filter values are bound parameters
 * (invariant 7). It returns counts, never events (invariant 2).
 */
@Injectable()
export class DeletionsRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  async create(
    userId: string,
    kind: "events" | "integration",
    filter: DeletionFilter,
  ): Promise<DeletionRow> {
    const [row] = await tenantScope(this.db, userId).insert(bulkDeletions, { kind, filter });
    return row as DeletionRow;
  }

  async findById(userId: string, id: string): Promise<DeletionRow | null> {
    const [row] = await tenantScope(this.db, userId).select(
      bulkDeletions,
      eq(bulkDeletions.id, id),
    );
    return row ?? null;
  }

  /** How many events the filter matches right now. */
  async countMatching(userId: string, filter: DeletionFilter): Promise<number> {
    assertUserScope(userId);
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(events)
      .where(scopeCondition(events, userId, and(...eventFilterConditions(toEventFilters(filter)))));
    return row?.count ?? 0;
  }

  /**
   * Deletes up to `limit` of the user's events that match the filter and returns how many. The
   * rows are locked in id order and waited for, not skipped: a skipped row (say, one the retention
   * recompute is updating) would survive a deletion that reports `completed`.
   */
  async deleteBatch(userId: string, filter: DeletionFilter, limit: number): Promise<number> {
    assertUserScope(userId);
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError("limit must be a positive integer");
    const matching = this.db
      .select({ id: events.id })
      .from(events)
      .where(scopeCondition(events, userId, and(...eventFilterConditions(toEventFilters(filter)))))
      .orderBy(events.id)
      .limit(limit)
      .for("update");
    const rows = await this.db
      .delete(events)
      .where(scopeCondition(events, userId, inArray(events.id, matching) as SQL))
      .returning({ id: events.id });
    return rows.length;
  }

  /** `running` stays `running` on a retry; a finished job is left alone. Returns the row, or null if it is finished. */
  async markRunning(userId: string, id: string): Promise<DeletionRow | null> {
    const rows = await tenantScope(this.db, userId).update(
      bulkDeletions,
      { status: "running", finishedAt: null },
      and(eq(bulkDeletions.id, id), inArray(bulkDeletions.status, ["queued", "running", "failed"])),
    );
    return rows[0] ?? null;
  }

  async setTotal(userId: string, id: string, total: number): Promise<void> {
    await tenantScope(this.db, userId).update(bulkDeletions, { total }, eq(bulkDeletions.id, id));
  }

  async addDeleted(userId: string, id: string, count: number): Promise<void> {
    await tenantScope(this.db, userId).update(
      bulkDeletions,
      { deleted: sql`${bulkDeletions.deleted} + ${count}` },
      eq(bulkDeletions.id, id),
    );
  }

  async finish(
    userId: string,
    id: string,
    status: "completed" | "failed",
    now: Date,
  ): Promise<void> {
    await tenantScope(this.db, userId).update(
      bulkDeletions,
      { status, finishedAt: now },
      eq(bulkDeletions.id, id),
    );
  }
}
