import { Inject, Injectable } from "@nestjs/common";
import type { RetentionPolicy, RetentionScope } from "@personal-api/contracts";
import { and, eq } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { integrations, retentionPolicies } from "../../platform/db/schema";
import { tenantScope } from "../../platform/db/tenant-scope";

type PolicyRow = typeof retentionPolicies.$inferSelect;

/** The user's policies as ingest needs them: days by event type and by integration id. */
export interface PolicyDays {
  type: ReadonlyMap<string, number>;
  source: ReadonlyMap<string, number>;
}

/**
 * Every public method takes `userId` as its FIRST argument and goes through `tenantScope`, so a
 * missing or blank userId rejects with `MissingUserScopeError` before the database is touched.
 * Keep helpers out of the class (or prefix them with `_`): the scoping spec walks the prototype.
 */
@Injectable()
export class RetentionRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(userId: string): Promise<RetentionPolicy[]> {
    const rows = await tenantScope(this.db, userId).select(retentionPolicies);
    return rows.map(toPolicy).sort(byScopeThenTarget);
  }

  /** Days by type and by source, for resolving the retention of an incoming batch. */
  async daysByTarget(userId: string): Promise<PolicyDays> {
    const rows = await tenantScope(this.db, userId).select(retentionPolicies);
    const type = new Map<string, number>();
    const source = new Map<string, number>();
    for (const row of rows) (row.scope === "type" ? type : source).set(row.target, row.days);
    return { type, source };
  }

  /** Whether the integration (any status) is the user's own. */
  async ownsIntegration(userId: string, integrationId: string): Promise<boolean> {
    const rows = await tenantScope(this.db, userId).select(
      integrations,
      eq(integrations.id, integrationId),
    );
    return rows.length > 0;
  }

  async upsert(
    userId: string,
    scope: RetentionScope,
    target: string,
    days: number,
    at: Date,
  ): Promise<RetentionPolicy> {
    tenantScope(this.db, userId);
    const [row] = await this.db
      .insert(retentionPolicies)
      .values({ userId, scope, target, days, updatedAt: at })
      .onConflictDoUpdate({
        target: [retentionPolicies.userId, retentionPolicies.scope, retentionPolicies.target],
        set: { days, updatedAt: at },
      })
      .returning();
    if (row === undefined) throw new Error("retention upsert returned no row");
    return toPolicy(row);
  }

  /** True when a policy existed. */
  async remove(userId: string, scope: RetentionScope, target: string): Promise<boolean> {
    const rows = await tenantScope(this.db, userId).delete(
      retentionPolicies,
      and(eq(retentionPolicies.scope, scope), eq(retentionPolicies.target, target)),
    );
    return rows.length > 0;
  }
}

function toPolicy(row: PolicyRow): RetentionPolicy {
  return {
    scope: row.scope as RetentionScope,
    target: row.target,
    days: row.days,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function byScopeThenTarget(a: RetentionPolicy, b: RetentionPolicy): number {
  if (a.scope !== b.scope) return a.scope === "type" ? -1 : 1;
  return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
}
