import type {
  ActivityDailyResponse,
  ActivityDay,
  ActivityDomain,
  ActivityDomainsResponse,
  ActivityHourCell,
  ActivityHoursResponse,
  ActivitySession,
  ActivitySessionsResponse,
  ActivitySiteResponse,
} from "@personal-api/contracts";

/**
 * Dashboard calls for /v1/activity (M8-03 Insights). Same-origin with the session cookie. Failures
 * throw a generic error (no body, URL or domain in the message), and nothing here logs.
 */
export type {
  ActivityDay,
  ActivityDomain,
  ActivityHourCell,
  ActivitySession,
  ActivitySiteResponse,
};

export const INSIGHTS_DAYS = 7;
export const INSIGHTS_TOP_DOMAINS = 10;

/** The last 7 local days in the user's time zone, today included. */
export interface InsightsWindow {
  /** UTC instant of local midnight 6 days ago (inclusive). */
  from: string;
  /** Now (exclusive). */
  to: string;
  /** `YYYY-MM-DD` local dates, oldest first, `today` last. */
  dates: string[];
  today: string;
}

/** Wall-clock parts of `instant` in `timeZone`. Throws a RangeError for a zone the browser lacks. */
function zonedParts(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** How far `timeZone` is ahead of UTC at `instant`, in ms. */
function offsetMs(instant: number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(instant / 1000) * 1000;
}

/** UTC instant of 00:00 on a local date. Two passes settle the offset across a DST change. */
function localMidnight(year: number, month: number, day: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day);
  const first = wall - offsetMs(wall, timeZone);
  return wall - offsetMs(first, timeZone);
}

const isoDate = (utcMidnight: number) => new Date(utcMidnight).toISOString().slice(0, 10);

/**
 * `count` local days in the user's zone ending `endOffset` days before today. The current window
 * (offset 0) ends now; an earlier one ends at the next local midnight.
 */
export function daysWindow(
  now: Date,
  timeZone: string,
  count: number,
  endOffset = 0,
): InsightsWindow {
  const { year, month, day } = zonedParts(now.getTime(), timeZone);
  const last = day - endOffset;
  const dates = Array.from({ length: count }, (_, i) =>
    isoDate(Date.UTC(year, month - 1, last - (count - 1 - i))),
  );
  const from = localMidnight(year, month, last - (count - 1), timeZone);
  const to = endOffset === 0 ? now.getTime() : localMidnight(year, month, last + 1, timeZone);
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    dates,
    today: dates[count - 1] as string,
  };
}

export function insightsWindow(now: Date, timeZone: string): InsightsWindow {
  return daysWindow(now, timeZone, INSIGHTS_DAYS);
}

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(`${path}?${new URLSearchParams(params)}`, {
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`Request failed (${res.status}).`);
  return (await res.json()) as T;
}

export interface Insights {
  window: InsightsWindow;
  /** One entry per window date, oldest first; days without activity are 0. */
  days: ActivityDay[];
  domains: ActivityDomain[];
}

/** Today's and the last 7 days' activity, with days cut in the user's saved time zone. */
export async function getInsights(timeZone: string, now = new Date()): Promise<Insights> {
  const window = insightsWindow(now, timeZone);
  const range = { from: window.from, to: window.to };
  const [daily, top] = await Promise.all([
    get<ActivityDailyResponse>("/v1/activity/daily", range),
    get<ActivityDomainsResponse>("/v1/activity/domains", {
      ...range,
      limit: String(INSIGHTS_TOP_DOMAINS),
    }),
  ]);
  const byDate = new Map(daily.days.map((d) => [d.date, d]));
  const days = window.dates.map((date) => byDate.get(date) ?? { date, activeMs: 0, pageVisits: 0 });
  return { window, days, domains: top.domains };
}

/** `2h 05m`, `12m`, `< 1m` or `0m`. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "0m";
  if (ms < 60_000) return "< 1m";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export const SITE_DAYS = 30;
export const HEATMAP_DAYS = 28;
export const COMPARE_DAYS = 7;
const COMPARE_DOMAINS = 100;
const SESSION_PAGE = 200;
const SESSION_MAX_PAGES = 5;

export interface SiteDetail extends Omit<ActivitySiteResponse, "days"> {
  /** One entry per local date of the window, oldest first; days without activity are 0. */
  days: ActivityDay[];
}

/** One domain over the last 30 local days. */
export async function getSite(
  domain: string,
  timeZone: string,
  now = new Date(),
): Promise<SiteDetail> {
  const window = daysWindow(now, timeZone, SITE_DAYS);
  const site = await get<ActivitySiteResponse>("/v1/activity/site", {
    domain,
    from: window.from,
    to: window.to,
  });
  const byDate = new Map(site.days.map((d) => [d.date, d]));
  const days = window.dates.map((date) => byDate.get(date) ?? { date, activeMs: 0, pageVisits: 0 });
  return { ...site, days };
}

/** Active time per weekday (0 = Monday) and hour over the last 4 local weeks. */
export async function getHours(timeZone: string, now = new Date()): Promise<ActivityHourCell[]> {
  const window = daysWindow(now, timeZone, HEATMAP_DAYS);
  const res = await get<ActivityHoursResponse>("/v1/activity/hours", {
    from: window.from,
    to: window.to,
  });
  return res.cells;
}

export interface SiteComparison {
  domain: string;
  thisWeekMs: number;
  lastWeekMs: number;
}

/** The last 7 local days against the 7 before them, per site, busiest this week first. */
export async function getWeekComparison(
  timeZone: string,
  now = new Date(),
  top = INSIGHTS_TOP_DOMAINS,
): Promise<SiteComparison[]> {
  const ask = (w: InsightsWindow) =>
    get<ActivityDomainsResponse>("/v1/activity/domains", {
      from: w.from,
      to: w.to,
      limit: String(COMPARE_DOMAINS),
    });
  const [current, previous] = await Promise.all([
    ask(daysWindow(now, timeZone, COMPARE_DAYS)),
    ask(daysWindow(now, timeZone, COMPARE_DAYS, COMPARE_DAYS)),
  ]);
  const rows = new Map<string, SiteComparison>();
  for (const d of current.domains) {
    rows.set(d.domain, { domain: d.domain, thisWeekMs: d.activeMs, lastWeekMs: 0 });
  }
  for (const d of previous.domains) {
    const row = rows.get(d.domain) ?? { domain: d.domain, thisWeekMs: 0, lastWeekMs: 0 };
    row.lastWeekMs = d.activeMs;
    rows.set(d.domain, row);
  }
  return [...rows.values()]
    .sort(
      (a, b) =>
        b.thisWeekMs - a.thisWeekMs ||
        b.lastWeekMs - a.lastWeekMs ||
        a.domain.localeCompare(b.domain),
    )
    .slice(0, top);
}

/** Today's focus sessions (local midnight to now), oldest first. Follows the cursor a few pages. */
export async function getTodaySessions(
  timeZone: string,
  now = new Date(),
): Promise<ActivitySession[]> {
  const window = daysWindow(now, timeZone, 1);
  const sessions: ActivitySession[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < SESSION_MAX_PAGES; page++) {
    const params: Record<string, string> = {
      from: window.from,
      to: window.to,
      limit: String(SESSION_PAGE),
    };
    if (cursor) params.cursor = cursor;
    const res: ActivitySessionsResponse = await get("/v1/activity/sessions", params);
    sessions.push(...res.sessions);
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return sessions.reverse();
}
