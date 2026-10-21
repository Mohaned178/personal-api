import { Inject, Injectable } from "@nestjs/common";
import { FOCUS_SEGMENT_MAX_MS } from "@personal-api/contracts";
import { and, desc, eq, gte, inArray, lt, type SQL, sql } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { events } from "../../platform/db/schema";
import { assertUserScope, scopeCondition } from "../../platform/db/tenant-scope";
import type { EventsCursor } from "../events/events.cursor";

const FOCUS_SEGMENT = "browser.focus_segment";
const PAGE_VISITED = "browser.page_visited";

export interface ActivityFilters {
  from: Date;
  /** Exclusive. */
  to: Date;
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

export interface HourRow {
  weekday: number;
  hour: number;
  activeMs: number;
}

export interface PathRow {
  path: string;
  activeMs: number;
  pageVisits: number;
}

export interface SiteRows {
  days: DayRow[];
  activeMs: number;
  pageVisits: number;
  sessions: number;
  longestSessionMs: number;
  paths: PathRow[];
}

export interface SessionRow {
  id: string;
  domain: string;
  occurredAt: Date;
  durationMs: number;
}

/**
 * Active time is the sum of focus-segment durations, each clamped to the 30-minute maximum again
 * here so a bad row can never inflate a total. Visits count page_visited events.
 */
export const activeMs = sql<string>`coalesce(sum(case when ${events.type} = ${FOCUS_SEGMENT} then least(greatest((${events.data} ->> 'durationMs')::bigint, 0), ${FOCUS_SEGMENT_MAX_MS}) else 0 end), 0)`;
const pageVisits = sql<string>`count(*) filter (where ${events.type} = ${PAGE_VISITED})`;
const segmentCount = sql<string>`count(*) filter (where ${events.type} = ${FOCUS_SEGMENT})`;
const longestSegment = sql<string>`coalesce(max(case when ${events.type} = ${FOCUS_SEGMENT} then least(greatest((${events.data} ->> 'durationMs')::bigint, 0), ${FOCUS_SEGMENT_MAX_MS}) else 0 end), 0)`;

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

  /** One domain over the range: days (cut in `timeZone`), totals, session stats and its busiest paths. */
  async site(
    userId: string,
    domain: string,
    filters: ActivityFilters,
    timeZone: string,
    pathLimit: number,
  ): Promise<SiteRows> {
    assertUserScope(userId);
    const where = scopeCondition(
      events,
      userId,
      and(activityCondition(filters), sql`${events.data} ->> 'domain' = ${domain}`),
    );
    const day = sql<string>`to_char(${events.occurredAt} at time zone ${timeZone}, 'YYYY-MM-DD')`;
    const path = sql<string>`${events.data} ->> 'path'`;
    const [dayRows, [total], pathRows] = await Promise.all([
      this.db
        .select({ date: day, activeMs, pageVisits })
        .from(events)
        .where(where)
        .groupBy(sql`1`)
        .orderBy(sql`1`),
      this.db
        .select({ activeMs, pageVisits, sessions: segmentCount, longest: longestSegment })
        .from(events)
        .where(where),
      this.db
        .select({ path, activeMs, pageVisits })
        .from(events)
        .where(and(where, sql`${path} is not null`))
        .groupBy(path)
        .orderBy(desc(activeMs), desc(pageVisits), path)
        .limit(pathLimit),
    ]);
    return {
      days: dayRows.map((r) => ({
        date: r.date,
        activeMs: Number(r.activeMs),
        pageVisits: Number(r.pageVisits),
      })),
      activeMs: Number(total?.activeMs ?? 0),
      pageVisits: Number(total?.pageVisits ?? 0),
      sessions: Number(total?.sessions ?? 0),
      longestSessionMs: Number(total?.longest ?? 0),
      paths: pathRows.map((r) => ({
        path: r.path,
        activeMs: Number(r.activeMs),
        pageVisits: Number(r.pageVisits),
      })),
    };
  }

  /** Active time per (ISO weekday 0 = Monday, hour) in `timeZone`; cells without activity are left out. */
  async hours(userId: string, filters: ActivityFilters, timeZone: string): Promise<HourRow[]> {
    assertUserScope(userId);
    const weekday = sql<number>`(extract(isodow from ${events.occurredAt} at time zone ${timeZone}) - 1)::int`;
    const hour = sql<number>`extract(hour from ${events.occurredAt} at time zone ${timeZone})::int`;
    const rows = await this.db
      .select({ weekday, hour, activeMs })
      .from(events)
      .where(scopeCondition(events, userId, activityCondition(filters)))
      .groupBy(sql`1`, sql`2`)
      .orderBy(sql`1`, sql`2`);
    return rows
      .map((r) => ({
        weekday: Number(r.weekday),
        hour: Number(r.hour),
        activeMs: Number(r.activeMs),
      }))
      .filter((r) => r.activeMs > 0);
  }

  /** Focus segments newest first on `(occurred_at, id)`. The caller asks for one row more than a page. */
  async sessions(
    userId: string,
    filters: ActivityFilters & { after?: EventsCursor | undefined },
    limit: number,
  ): Promise<SessionRow[]> {
    assertUserScope(userId);
    const conditions: (SQL | undefined)[] = [
      gte(events.occurredAt, filters.from),
      lt(events.occurredAt, filters.to),
      eq(events.type, FOCUS_SEGMENT),
    ];
    if (filters.after) {
      conditions.push(
        sql`(${events.occurredAt}, ${events.id}) < (${sql.param(filters.after.occurredAt, events.occurredAt)}, ${filters.after.id}::uuid)`,
      );
    }
    const rows = await this.db
      .select({
        id: events.id,
        occurredAt: events.occurredAt,
        domain: sql<string>`${events.data} ->> 'domain'`,
        durationMs: sql<string>`least(greatest((${events.data} ->> 'durationMs')::bigint, 0), ${FOCUS_SEGMENT_MAX_MS})`,
      })
      .from(events)
      .where(scopeCondition(events, userId, and(...conditions)))
      .orderBy(desc(events.occurredAt), desc(events.id))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      domain: r.domain,
      occurredAt: r.occurredAt,
      durationMs: Number(r.durationMs),
    }));
  }
}

function activityCondition(filters: ActivityFilters): SQL {
  return and(
    gte(events.occurredAt, filters.from),
    lt(events.occurredAt, filters.to),
    inArray(events.type, [FOCUS_SEGMENT, PAGE_VISITED]),
  ) as SQL;
}
