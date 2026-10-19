import { Inject, Injectable } from "@nestjs/common";
import { FOCUS_SEGMENT_MAX_MS } from "@personal-api/contracts";
import { and, desc, gte, inArray, lt, type SQL, sql } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { events } from "../../platform/db/schema";
import { assertUserScope, scopeCondition } from "../../platform/db/tenant-scope";
import { restrictionConditions } from "../events/events.repository";

const FOCUS_SEGMENT = "browser.focus_segment";
const PAGE_VISITED = "browser.page_visited";

export interface ActivityFilters {
  from: Date;
  /** Exclusive. */
  to: Date;
  /** A read key's restriction: ANDed on, so it can only narrow what is counted. */
  sources?: string[] | undefined;
  types?: string[] | undefined;
}

export interface DayRow {
  date: string;
  activeMs: number;
  pageVisits: number;
}

export interface DomainRow {
  domain: string;
  activeMs: number;
  pageVisits: number;
}

/**
 * Active time is the sum of focus-segment durations, each clamped to the 30-minute maximum again
 * here so a bad row can never inflate a total. Visits count page_visited events.
 */
const activeMs = sql<string>`coalesce(sum(case when ${events.type} = ${FOCUS_SEGMENT} then least(greatest((${events.data} ->> 'durationMs')::bigint, 0), ${FOCUS_SEGMENT_MAX_MS}) else 0 end), 0)`;
const pageVisits = sql<string>`count(*) filter (where ${events.type} = ${PAGE_VISITED})`;

/**
 * Aggregates run in SQL at query time. Every method takes `userId` as its FIRST argument and ANDs
 * it on through `scopeCondition`, so a missing or blank userId rejects before the database is
 * touched. Values (including the time zone) are bound parameters (invariant 7). Keep helpers out
 * of the class (or prefix them with `_`): the scoping spec walks the prototype.
 */
@Injectable()
export class ActivityRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Days (cut in `timeZone`) that have activity, oldest first. */
  async daily(userId: string, filters: ActivityFilters, timeZone: string): Promise<DayRow[]> {
    assertUserScope(userId);
    const day = sql<string>`to_char(${events.occurredAt} at time zone ${timeZone}, 'YYYY-MM-DD')`;
    const rows = await this.db
      .select({ date: day, activeMs, pageVisits })
      .from(events)
      .where(scopeCondition(events, userId, activityCondition(filters)))
      // Positional: the bound time zone is a separate parameter wherever `day` is repeated.
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    return rows.map((r) => ({
      date: r.date,
      activeMs: Number(r.activeMs),
      pageVisits: Number(r.pageVisits),
    }));
  }

  /** Busiest domains first: active time, then visits, then name. */
  async domains(userId: string, filters: ActivityFilters, limit: number): Promise<DomainRow[]> {
    assertUserScope(userId);
    const domain = sql<string>`${events.data} ->> 'domain'`;
    const rows = await this.db
      .select({ domain, activeMs, pageVisits })
      .from(events)
      .where(
        scopeCondition(events, userId, and(activityCondition(filters), sql`${domain} is not null`)),
      )
      .groupBy(domain)
      .orderBy(desc(activeMs), desc(pageVisits), domain)
      .limit(limit);
    return rows.map((r) => ({
      domain: r.domain,
      activeMs: Number(r.activeMs),
      pageVisits: Number(r.pageVisits),
    }));
  }
}

function activityCondition(filters: ActivityFilters): SQL {
  return and(
    gte(events.occurredAt, filters.from),
    lt(events.occurredAt, filters.to),
    inArray(events.type, [FOCUS_SEGMENT, PAGE_VISITED]),
    ...restrictionConditions(filters.sources, filters.types),
  ) as SQL;
}
