import { Inject, Injectable } from "@nestjs/common";
import type { ExportFilter } from "@personal-api/contracts";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { dataExports as exportsTable } from "../../platform/db/schema";
import { assertUserScope, scopeCondition, tenantScope } from "../../platform/db/tenant-scope";

export type ExportRow = typeof exportsTable.$inferSelect;

/**
 * Every method takes `userId` as its FIRST argument and ANDs it onto the query through the tenant
 * helpers, so no query can reach another user's row. It holds filters, counters and paths, never
 * events (invariant 2).
 */
@Injectable()
export class ExportsRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  async create(userId: string, filter: ExportFilter): Promise<ExportRow> {
    const [row] = await tenantScope(this.db, userId).insert(exportsTable, { filter });
    return row as ExportRow;
  }

  async findById(userId: string, id: string): Promise<ExportRow | null> {
    const [row] = await tenantScope(this.db, userId).select(exportsTable, eq(exportsTable.id, id));
    return row ?? null;
  }

  /**
   * How many of the user's exports are unfinished (`queued` or `running`), and how many were
   * created after `since`. What the per-user caps look at.
   */
  async countRecent(userId: string, since: Date): Promise<{ active: number; recent: number }> {
    assertUserScope(userId);
    const [row] = await this.db
      .select({
        active: sql<number>`(count(*) filter (where ${exportsTable.status} in ('queued', 'running')))::int`,
        recent: sql<number>`(count(*) filter (where ${exportsTable.createdAt} > ${sql.param(since, exportsTable.createdAt)}))::int`,
      })
      .from(exportsTable)
      .where(scopeCondition(exportsTable, userId));
    return { active: row?.active ?? 0, recent: row?.recent ?? 0 };
  }

  /**
   * The newest exports first, on `(created_at, id)`, after the keyset position `after` if given.
   * The cursor carries the timestamp to the millisecond; the per-user caps keep a user's exports to
   * a handful, created far apart, so two never share a millisecond.
   */
  async list(
    userId: string,
    limit: number,
    after?: { createdAt: Date; id: string },
  ): Promise<ExportRow[]> {
    assertUserScope(userId);
    const position = after
      ? sql`(${exportsTable.createdAt}, ${exportsTable.id}) < (${sql.param(after.createdAt, exportsTable.createdAt)}, ${after.id}::uuid)`
      : undefined;
    return this.db
      .select()
      .from(exportsTable)
      .where(scopeCondition(exportsTable, userId, position))
      .orderBy(desc(exportsTable.createdAt), desc(exportsTable.id))
      .limit(limit);
  }

  async listIds(userId: string): Promise<string[]> {
    const rows = await tenantScope(this.db, userId).select(exportsTable);
    return rows.map((row) => row.id);
  }

  /** `running` stays `running` on a retry; a completed export is left alone (returns null). */
  async markRunning(userId: string, id: string): Promise<ExportRow | null> {
    const rows = await tenantScope(this.db, userId).update(
      exportsTable,
      { status: "running", finishedAt: null },
      and(eq(exportsTable.id, id), inArray(exportsTable.status, ["queued", "running", "failed"])),
    );
    return rows[0] ?? null;
  }

  /** Returns how many rows were updated: 0 when the export row no longer exists. */
  async complete(
    userId: string,
    id: string,
    result: {
      filePath: string;
      eventCount: number;
      sizeBytes: number;
      finishedAt: Date;
      expiresAt: Date;
    },
  ): Promise<number> {
    const rows = await tenantScope(this.db, userId).update(
      exportsTable,
      { status: "completed", ...result },
      eq(exportsTable.id, id),
    );
    return rows.length;
  }

  /** Returns how many rows were updated: 0 when the export row no longer exists. */
  async fail(userId: string, id: string, finishedAt: Date): Promise<number> {
    const rows = await tenantScope(this.db, userId).update(
      exportsTable,
      { status: "failed", finishedAt },
      eq(exportsTable.id, id),
    );
    return rows.length;
  }
}
