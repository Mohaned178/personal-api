import { Inject, Injectable } from "@nestjs/common";
import type { RetentionPolicy, RetentionScope } from "@personal-api/contracts";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { events, integrations, retentionPolicies } from "../../platform/db/schema";
import { assertUserScope, scopeCondition, tenantScope } from "../../platform/db/tenant-scope";

type PolicyRow = typeof retentionPolicies.$inferSelect;

/** The user's policies as ingest needs them: days by event type and by integration id. */
export interface PolicyDays {
  type: ReadonlyMap<string, number>;
  source: ReadonlyMap<string, number>;
}

/** Where the recompute left off: keyset on `(occurred_at, id)`, newest first, like the events list. */
export interface ExpiryCursor {
  occurredAt: Date;
  id: string;
}

/** Just what the recompute needs of an event. Never the payload. */
export interface ExpiryRow extends ExpiryCursor {
  type: string;
  integrationId: string;
  receivedAt: Date;
  expiresAt: Date | null;
}

/** The action name a rule's trace lists when `set_retention` fired (`ruleTraceSchema`). */
const SET_RETENTION_ACTION = "set_retention";

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

  /**
   * One page of the user's events whose expiry the policies decide, newest first. Events a
   * `set_retention` rule governs are left out: the rule beats every policy, and the days it chose
   * are not stored, only the fact in the trace. A NULL or missing trace is not governed.
   */
  async expiryPage(
    userId: string,
    after: ExpiryCursor | null,
    limit: number,
  ): Promise<ExpiryRow[]> {
    const conditions = [
      sql`not coalesce(jsonb_path_exists(${events.trace}, '$.matched[*].actions[*] ? (@ == $action)', jsonb_build_object('action', ${SET_RETENTION_ACTION}::text)), false)`,
    ];
    if (after) {
      conditions.push(
        sql`(${events.occurredAt}, ${events.id}) < (${sql.param(after.occurredAt, events.occurredAt)}, ${after.id}::uuid)`,
      );
    }
    const where = scopeCondition(events, userId, and(...conditions));
    return this.db
      .select({
        id: events.id,
        occurredAt: events.occurredAt,
        type: events.type,
        integrationId: events.integrationId,
        receivedAt: events.receivedAt,
        expiresAt: events.expiresAt,
      })
      .from(events)
      .where(where)
      .orderBy(desc(events.occurredAt), desc(events.id))
      .limit(limit);
  }

  /** Sets `expires_at = received_at + days` on the user's events with these ids. Returns the count. */
  async setExpiry(userId: string, ids: string[], days: number): Promise<number> {
    assertUserScope(userId);
    if (ids.length === 0) return 0;
    const rows = await this.db
      .update(events)
      .set({
        // Exact seconds, like the ingest does, so a DST change in the session zone cannot shift it.
        expiresAt: sql`${events.receivedAt} + make_interval(secs => ${days * 86_400}::float8)`,
      })
      .where(scopeCondition(events, userId, inArray(events.id, ids)))
      .returning({ id: events.id });
    return rows.length;
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
