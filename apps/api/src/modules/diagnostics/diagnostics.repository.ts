import { Inject, Injectable } from "@nestjs/common";
import { gte } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { ingestionLog, integrations } from "../../platform/db/schema";
import { tenantScope } from "../../platform/db/tenant-scope";

export type IntegrationRow = typeof integrations.$inferSelect;
export type IngestionLogRow = typeof ingestionLog.$inferSelect;

/**
 * Every method takes `userId` as its FIRST argument and goes through `tenantScope`, so a missing
 * or blank userId rejects before the database is touched and no query can reach another user's
 * row. Keep helpers out of the class (or prefix them with `_`): the scoping spec walks the prototype.
 */
@Injectable()
export class DiagnosticsRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** A user has a handful of sources: no paging. */
  async listIntegrations(userId: string): Promise<IntegrationRow[]> {
    return tenantScope(this.db, userId).select(integrations);
  }

  /** Hourly counter rows whose bucket is at or after `since`. */
  async ingestionSince(userId: string, since: Date): Promise<IngestionLogRow[]> {
    return tenantScope(this.db, userId).select(ingestionLog, gte(ingestionLog.bucket, since));
  }
}
