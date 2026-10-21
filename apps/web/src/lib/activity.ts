import type {
  ActivityDailyResponse,
  ActivityDay,
  ActivityDomain,
  ActivityDomainsResponse,
} from "@personal-api/contracts";

/**
 * Dashboard calls for /v1/activity (M8-03 Insights). Same-origin with the session cookie. Failures
 * throw a generic error (no body, URL or domain in the message), and nothing here logs.
 */
export type { ActivityDay, ActivityDomain };

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

export function insightsWindow(now: Date, timeZone: string): InsightsWindow {
  const { year, month, day } = zonedParts(now.getTime(), timeZone);
  const dates = Array.from({ length: INSIGHTS_DAYS }, (_, i) =>
    isoDate(Date.UTC(year, month - 1, day - (INSIGHTS_DAYS - 1 - i))),
  );
  const from = localMidnight(year, month, day - (INSIGHTS_DAYS - 1), timeZone);
  return {
    from: new Date(from).toISOString(),
    to: now.toISOString(),
    dates,
    today: dates[INSIGHTS_DAYS - 1] as string,
  };
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
