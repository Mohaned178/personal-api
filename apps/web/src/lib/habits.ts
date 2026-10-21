import type {
  ActivityCategoriesResponse,
  Category,
  CategoryDay,
  CategoryListResponse,
  CategoryRule,
  CategoryRuleSave,
  Goal,
  GoalCategory,
  GoalListResponse,
  Limit,
} from "@personal-api/contracts";
import {
  daysWindow,
  getSite,
  getWeekComparison,
  type InsightsWindow,
  type SiteComparison,
} from "@/lib/activity";
import { listLimits } from "@/lib/limits";

/**
 * Dashboard calls for categories, goals and the weekly summary (M9-07), and the pure arithmetic on
 * their answers (split, goal streak, summary). Same-origin with the session cookie. A failure
 * throws a `HabitsError` with the status and the problem `code` only (never the body, which could
 * repeat a site), and nothing here logs.
 */
export type { Category, CategoryDay, CategoryRule, CategoryRuleSave, Goal, GoalCategory };

export class HabitsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`Request failed (${status}).`);
  }
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    const problem = (await res.json().catch(() => null)) as { code?: unknown } | null;
    throw new HabitsError(res.status, typeof problem?.code === "string" ? problem.code : null);
  }
  return res;
}

export const listCategories = async (): Promise<CategoryListResponse> =>
  (await send("GET", "/v1/categories")).json() as Promise<CategoryListResponse>;

export async function createCategory(save: CategoryRuleSave): Promise<void> {
  await send("POST", "/v1/categories", save);
}

export async function replaceCategory(id: string, save: CategoryRuleSave): Promise<void> {
  await send("PUT", `/v1/categories/${encodeURIComponent(id)}`, save);
}

export async function deleteCategory(id: string): Promise<void> {
  await send("DELETE", `/v1/categories/${encodeURIComponent(id)}`);
}

export async function listGoals(): Promise<Goal[]> {
  return ((await (await send("GET", "/v1/goals")).json()) as GoalListResponse).goals;
}

export async function putGoal(category: GoalCategory, minutes: number): Promise<void> {
  await send("PUT", `/v1/goals/${category}`, { minutes });
}

export async function deleteGoal(category: GoalCategory): Promise<void> {
  await send("DELETE", `/v1/goals/${category}`);
}

export const HABITS_DAYS = 30;
const SUMMARY_DAYS = 7;
const SUMMARY_LIMIT_SITES = 20;
const SUMMARY_CHANGES = 5;

export interface CategoryWindow {
  window: InsightsWindow;
  /** One entry per window date, oldest first; days without activity are 0. */
  days: CategoryDay[];
}

/** The split per local day over the last `count` days (30 by default), zero-filled. */
export async function getCategoryDays(
  timeZone: string,
  now = new Date(),
  count = HABITS_DAYS,
): Promise<CategoryWindow> {
  const window = daysWindow(now, timeZone, count);
  const res = await fetch(
    `/v1/activity/categories?${new URLSearchParams({ from: window.from, to: window.to })}`,
    {
      credentials: "same-origin",
    },
  );
  if (!res.ok) throw new HabitsError(res.status, null);
  const body = (await res.json()) as ActivityCategoriesResponse;
  const byDate = new Map(body.days.map((d) => [d.date, d]));
  const days = window.dates.map(
    (date) => byDate.get(date) ?? { date, productiveMs: 0, neutralMs: 0, distractingMs: 0 },
  );
  return { window, days };
}

export interface CategoryTotals {
  productiveMs: number;
  neutralMs: number;
  distractingMs: number;
  totalMs: number;
}

export function totalsOf(days: readonly CategoryDay[]): CategoryTotals {
  const sums = { productiveMs: 0, neutralMs: 0, distractingMs: 0 };
  for (const day of days) {
    sums.productiveMs += day.productiveMs;
    sums.neutralMs += day.neutralMs;
    sums.distractingMs += day.distractingMs;
  }
  return { ...sums, totalMs: sums.productiveMs + sums.neutralMs + sums.distractingMs };
}

export const categoryMs = (day: CategoryDay, category: Category): number =>
  category === "productive"
    ? day.productiveMs
    : category === "neutral"
      ? day.neutralMs
      : day.distractingMs;

const MINUTE_MS = 60_000;

export interface GoalProgress {
  /** Time in the goal's category on the last day of `days` (today). */
  todayMs: number;
  /** Consecutive days, ending today, at or under the goal. 0 once today is over it. */
  streak: number;
  /** The streak reaches back to the first day of `days`, so it may be longer. */
  capped: boolean;
}

/**
 * Where a "stay under" goal stands. `days` are consecutive local days, oldest first, the last one
 * today (zero-filled). A day with no activity is a kept day only from the first day with activity
 * on: before that the extension was not tracking, which is not a streak. Today counts while it is
 * still under the goal and drops the streak to 0 the moment it is over.
 */
export function goalProgress(
  days: readonly CategoryDay[],
  category: GoalCategory,
  goalMinutes: number,
): GoalProgress {
  const goalMs = goalMinutes * MINUTE_MS;
  const today = days[days.length - 1];
  const first = days.findIndex((d) => d.productiveMs + d.neutralMs + d.distractingMs > 0);
  const todayMs = today ? categoryMs(today, category) : 0;
  if (first === -1) return { todayMs, streak: 0, capped: false };
  let streak = 0;
  for (let i = days.length - 1; i >= first; i--) {
    if (categoryMs(days[i] as CategoryDay, category) > goalMs) break;
    streak++;
  }
  return { todayMs, streak, capped: first === 0 && streak === days.length };
}

export interface SiteChange extends SiteComparison {
  deltaMs: number;
}

/** The sites whose time moved the most between the two weeks, in either direction. */
export function topChanges(rows: readonly SiteComparison[], count = SUMMARY_CHANGES): SiteChange[] {
  return rows
    .map((row) => ({ ...row, deltaMs: row.thisWeekMs - row.lastWeekMs }))
    .filter((row) => row.deltaMs !== 0)
    .sort((a, b) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs) || a.domain.localeCompare(b.domain))
    .slice(0, count);
}

export interface LimitDays {
  /** Days (of the week) a limit on a single site was kept, over all such limits. */
  kept: number;
  /** Days that count: 7 for each limit on a single site. */
  total: number;
  /** Limits on a pattern with a wildcard, which the summary cannot count per day. */
  skipped: number;
}

/** A limit is kept on a day when the site's time is at or under it. `perSite` is the last 7 days. */
export function limitDays(
  limits: readonly Limit[],
  perSite: ReadonlyMap<string, readonly { activeMs: number }[]>,
): LimitDays {
  let kept = 0;
  let total = 0;
  let skipped = 0;
  for (const limit of limits) {
    const days = perSite.get(limit.pattern);
    if (limit.pattern.startsWith("*.") || days === undefined) {
      skipped++;
      continue;
    }
    for (const day of days) {
      total++;
      if (day.activeMs <= limit.minutes * MINUTE_MS) kept++;
    }
  }
  return { kept, total, skipped };
}

export interface GoalWeek {
  category: GoalCategory;
  minutes: number;
  /** Days of this week at or under the goal. */
  daysKept: number;
  days: number;
  streak: number;
  capped: boolean;
}

export interface WeeklySummary {
  thisWeek: CategoryTotals;
  lastWeek: CategoryTotals;
  changes: SiteChange[];
  goals: GoalWeek[];
  limits: LimitDays;
}

/** Everything the summary page shows, from the answers of the routes. Pure. */
export function summarize(input: {
  /** The last 14 local days, oldest first: the week before, then this week. */
  days: readonly CategoryDay[];
  comparison: readonly SiteComparison[];
  goals: readonly Goal[];
  limits: readonly Limit[];
  perSite: ReadonlyMap<string, readonly { activeMs: number }[]>;
}): WeeklySummary {
  const thisDays = input.days.slice(-SUMMARY_DAYS);
  const lastDays = input.days.slice(-2 * SUMMARY_DAYS, -SUMMARY_DAYS);
  return {
    thisWeek: totalsOf(thisDays),
    lastWeek: totalsOf(lastDays),
    changes: topChanges(input.comparison),
    goals: input.goals.map((goal) => {
      const progress = goalProgress(input.days, goal.category, goal.minutes);
      return {
        category: goal.category,
        minutes: goal.minutes,
        daysKept: thisDays.filter((d) => categoryMs(d, goal.category) <= goal.minutes * MINUTE_MS)
          .length,
        days: thisDays.length,
        streak: progress.streak,
        capped: progress.capped,
      };
    }),
    limits: limitDays(input.limits, input.perSite),
  };
}

/** The last 7 days against the 7 before: time split, sites that moved, goals and limits kept. */
export async function getWeeklySummary(timeZone: string, now = new Date()): Promise<WeeklySummary> {
  const [{ days }, comparison, goals, limits] = await Promise.all([
    getCategoryDays(timeZone, now, 2 * SUMMARY_DAYS),
    getWeekComparison(timeZone, now, 100),
    listGoals(),
    listLimits(),
  ]);
  const exact = limits.filter((l) => !l.pattern.startsWith("*.")).slice(0, SUMMARY_LIMIT_SITES);
  const perSite = new Map<string, { activeMs: number }[]>();
  await Promise.all(
    exact.map(async (limit) => {
      const site = await getSite(limit.pattern, timeZone, now);
      perSite.set(limit.pattern, site.days.slice(-SUMMARY_DAYS));
    }),
  );
  return summarize({ days, comparison, goals, limits, perSite });
}
