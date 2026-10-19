import { Inject, Injectable } from "@nestjs/common";
import type { ExportFilter } from "@personal-api/contracts";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { exports as exportsTable } from "../../platform/db/schema";
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

  /** The newest exports first, on `(created_at, id)`. */
  async list(userId: string, limit: number): Promise<ExportRow[]> {
    assertUserScope(userId);
    return this.db
      .select()
      .from(exportsTable)
      .where(scopeCondition(exportsTable, userId))
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
  ): Promise<void> {
    await tenantScope(this.db, userId).update(
      exportsTable,
      { status: "completed", ...result },
      eq(exportsTable.id, id),
    );
  }

  async fail(userId: string, id: string, finishedAt: Date): Promise<void> {
    await tenantScope(this.db, userId).update(
      exportsTable,
      { status: "failed", finishedAt },
      eq(exportsTable.id, id),
    );
  }
}
