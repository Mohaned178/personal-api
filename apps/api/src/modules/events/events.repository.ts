import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, inArray, lt, or, type SQL, sql } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { events } from "../../platform/db/schema";
import { assertUserScope, scopeCondition, tenantScope } from "../../platform/db/tenant-scope";
import type { EventsCursor } from "./events.cursor";

export type EventRow = typeof events.$inferSelect;

export interface EventFilters {
  integrationId?: string | undefined;
  type?: string | undefined;
  from?: Date | undefined;
  /** Exclusive. */
  to?: Date | undefined;
  domain?: string | undefined;
  after?: EventsCursor | undefined;
  /** A read key's restriction: ANDed with the filters above, so it can only narrow a result. */
  sources?: string[] | undefined;
  /** Event types or `*` globs (see `globToLike`); a row passes if any one matches. */
  types?: string[] | undefined;
}

/**
 * A type glob as a LIKE pattern. The contract limits patterns to `[a-z0-9_.*]`, so `_` (a LIKE
 * wildcard) is the only character to escape; `*` becomes `%`. The result is a bound parameter.
 * Anything outside that alphabet is refused rather than escaped, so a bad pattern never widens.
 */
export function globToLike(pattern: string): string {
  if (!/^[a-z0-9_.*]+$/.test(pattern)) throw new Error("Unsupported type pattern");
  return pattern.replaceAll("_", "\\_").replaceAll("*", "%");
}

/** A read key's restriction as conditions to AND on; empty when the key has none. */
export function restrictionConditions(
  sources: string[] | undefined,
  types: string[] | undefined,
): SQL[] {
  const conditions: SQL[] = [];
  if (sources) conditions.push(inArray(events.integrationId, sources));
  if (types) {
    const matches = types.map((t) =>
      t.includes("*") ? sql`${events.type} LIKE ${globToLike(t)}` : eq(events.type, t),
    );
    conditions.push(or(...matches) as SQL);
  }
  return conditions;
}

/**
 * Every method takes `userId` as its FIRST argument and ANDs it onto the query through the tenant
 * helpers, so a missing or blank userId rejects before the database is touched and no query can
 * reach another user's row. Keep helpers out of the class (or prefix them with `_`): the scoping
 * spec walks the prototype. Filter values are always bound parameters (invariant 7).
 */
@Injectable()
export class EventsRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Newest first on `(occurred_at, id)`. The caller asks for one row more than a page. */
  async list(userId: string, filters: EventFilters, limit: number): Promise<EventRow[]> {
    assertUserScope(userId);
    const conditions: SQL[] = [];
    if (filters.integrationId) conditions.push(eq(events.integrationId, filters.integrationId));
    if (filters.type) conditions.push(eq(events.type, filters.type));
    if (filters.from) conditions.push(gte(events.occurredAt, filters.from));
    if (filters.to) conditions.push(lt(events.occurredAt, filters.to));
    conditions.push(...restrictionConditions(filters.sources, filters.types));
    if (filters.domain) conditions.push(sql`${events.data} ->> 'domain' = ${filters.domain}`);
    if (filters.after) {
      conditions.push(
        sql`(${events.occurredAt}, ${events.id}) < (${sql.param(filters.after.occurredAt, events.occurredAt)}, ${filters.after.id}::uuid)`,
      );
    }
    return this.db
      .select()
      .from(events)
      .where(scopeCondition(events, userId, and(...conditions)))
      .orderBy(desc(events.occurredAt), desc(events.id))
      .limit(limit);
  }

  async findById(userId: string, id: string): Promise<EventRow | null> {
    const [row] = await tenantScope(this.db, userId).select(events, eq(events.id, id));
    return row ?? null;
  }

  /** Returns how many of the ids were the user's and are now gone. */
  async deleteByIds(userId: string, ids: string[]): Promise<number> {
    const rows = await tenantScope(this.db, userId).delete(events, inArray(events.id, ids));
    return rows.length;
  }
}
