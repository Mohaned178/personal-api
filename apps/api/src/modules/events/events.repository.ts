import { Inject, Injectable } from "@nestjs/common";
import type { ListEventsQuery } from "@personal-api/contracts";
import { and, desc, eq, gte, inArray, lt, type SQL, sql } from "drizzle-orm";
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
}

/** The filter fields of an export or a bulk deletion (dates are ISO strings) as repository filters. */
export function toEventFilters(
  filter: Pick<ListEventsQuery, "source" | "type" | "from" | "to" | "domain">,
): EventFilters {
  return {
    integrationId: filter.source,
    type: filter.type,
    from: filter.from ? new Date(filter.from) : undefined,
    to: filter.to ? new Date(filter.to) : undefined,
    domain: filter.domain,
  };
}

/** The filter fields as conditions to AND on (not the cursor). Values are bound parameters. */
export function eventFilterConditions(filters: EventFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.integrationId) conditions.push(eq(events.integrationId, filters.integrationId));
  if (filters.type) conditions.push(eq(events.type, filters.type));
  if (filters.from) conditions.push(gte(events.occurredAt, filters.from));
  if (filters.to) conditions.push(lt(events.occurredAt, filters.to));
  if (filters.domain) conditions.push(sql`${events.data} ->> 'domain' = ${filters.domain}`);
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
    const conditions = eventFilterConditions(filters);
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
