import {
  type ActivityDomain,
  type Category,
  type CategoryList,
  categoryListSchema,
  categoryOf,
  DEFAULT_CATEGORIES,
  type Goals,
  goalsSchema,
  type Limit,
} from "@personal-api/contracts";
import { domainMatches } from "@personal-api/rules";
import { daysWindow, getDomainTotals } from "./activity";

/**
 * Categories, goals and the weekly summary (M9-07). The category list and the goals live in this
 * browser (like dismissed recommendations) and are cleared on sign-out; nothing here is sent to the
 * server. Everything is computed from the session-only `/v1/activity/domains` totals, one call per
 * local day. A day's list holds at most the 100 busiest sites, so the smallest sites can be missing.
 */
export const MIN = 60_000;
export const SUMMARY_DAYS = 7;
const CATEGORIES_KEY = "personal-api.categories";
const GOALS_KEY = "personal-api.goals";

export function readCategories(): CategoryList {
  try {
    const raw = window.localStorage.getItem(CATEGORIES_KEY);
    if (raw === null) return DEFAULT_CATEGORIES;
    const parsed = categoryListSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_CATEGORIES;
  } catch {
    return DEFAULT_CATEGORIES;
  }
}

export function saveCategories(list: CategoryList): void {
  try {
    window.localStorage.setItem(CATEGORIES_KEY, JSON.stringify(list));
  } catch {
    // Storage can be blocked; the change lasts until the page reloads.
  }
}

export function readGoals(): Goals {
  try {
    const parsed = goalsSchema.safeParse(
      JSON.parse(window.localStorage.getItem(GOALS_KEY) ?? "{}"),
    );
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function saveGoals(goals: Goals): void {
  try {
    window.localStorage.setItem(GOALS_KEY, JSON.stringify(goals));
  } catch {
    // Storage can be blocked; the goals last until the page reloads.
  }
}

/** Forget this user's list and goals, so the next person on this browser starts clean. */
export function clearHabits(): void {
  try {
    window.localStorage.removeItem(CATEGORIES_KEY);
    window.localStorage.removeItem(GOALS_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}

export type CategoryTotals = Record<Category, number>;

export function splitByCategory(
  domains: readonly ActivityDomain[],
  list: CategoryList,
): CategoryTotals {
  const totals: CategoryTotals = { productive: 0, neutral: 0, distracting: 0 };
  for (const d of domains) totals[categoryOf(d.domain, list)] += d.activeMs;
  return totals;
}

const sum = (domains: readonly ActivityDomain[]) => domains.reduce((s, d) => s + d.activeMs, 0);

export interface DayDomains {
  /** `YYYY-MM-DD` in the user's time zone. */
  date: string;
  domains: ActivityDomain[];
}

/** The last `count` local days, oldest first and today last, one `domains` call per day. */
export async function getDayDomains(
  timeZone: string,
  count: number,
  now = new Date(),
): Promise<DayDomains[]> {
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const w = daysWindow(now, timeZone, 1, count - 1 - i);
      return { date: w.today, domains: await getDomainTotals(w) };
    }),
  );
}

export const GOAL_CATEGORIES = ["distracting", "productive"] as const satisfies readonly Category[];
export type GoalCategory = (typeof GOAL_CATEGORIES)[number];

/**
 * A day meets a goal when something was tracked that day and the category's time is under the
 * ceiling (distracting) or at least the floor (productive). A day with nothing tracked meets
 * nothing, because the extension may simply have been off.
 */
export function goalMet(
  category: GoalCategory,
  minutes: number,
  categoryMs: number,
  trackedMs: number,
): boolean {
  if (trackedMs <= 0) return false;
  return category === "distracting" ? categoryMs <= minutes * MIN : categoryMs >= minutes * MIN;
}

export interface GoalProgress {
  category: GoalCategory;
  minutes: number;
  /** Time in the category so far today. */
  todayMs: number;
  /** Whether today meets the goal so far (an "under" goal can still be broken). */
  todayMet: boolean;
  /** Finished days in a row that met the goal, ending yesterday. */
  streak: number;
}

/** `days` is oldest first with today last. Today is shown but not counted in the streak. */
export function goalProgress(
  days: readonly DayDomains[],
  list: CategoryList,
  category: GoalCategory,
  minutes: number,
): GoalProgress {
  const met = (day: DayDomains) =>
    goalMet(category, minutes, splitByCategory(day.domains, list)[category], sum(day.domains));
  const today = days[days.length - 1];
  let streak = 0;
  for (let i = days.length - 2; i >= 0; i--) {
    if (!met(days[i] as DayDomains)) break;
    streak++;
  }
  return {
    category,
    minutes,
    todayMs: today ? splitByCategory(today.domains, list)[category] : 0,
    todayMet: today ? met(today) : false,
    streak,
  };
}

export interface SiteChange {
  domain: string;
  thisWeekMs: number;
  lastWeekMs: number;
}

export interface WeeklySummary {
  thisWeek: CategoryTotals & { totalMs: number };
  lastWeek: CategoryTotals & { totalMs: number };
  /** Limit-days with tracked time: how many stayed within the limit, out of how many. */
  limits: { kept: number; checked: number };
  /** The biggest rises and falls against last week, at most `TOP_CHANGES` each. */
  increases: SiteChange[];
  decreases: SiteChange[];
}

const TOP_CHANGES = 3;

function weekTotals(days: readonly DayDomains[], list: CategoryList) {
  const all = days.flatMap((d) => d.domains);
  return { ...splitByCategory(all, list), totalMs: sum(all) };
}

/** `days` is oldest first, today last: the last 7 are this week and the 7 before them last week. */
export function weeklySummary(
  days: readonly DayDomains[],
  list: CategoryList,
  limits: readonly Limit[],
): WeeklySummary {
  const thisDays = days.slice(-SUMMARY_DAYS);
  const lastDays = days.slice(-2 * SUMMARY_DAYS, -SUMMARY_DAYS);

  let kept = 0;
  let checked = 0;
  for (const day of thisDays) {
    if (sum(day.domains) <= 0) continue;
    for (const limit of limits) {
      const used = sum(day.domains.filter((d) => domainMatches(limit.pattern, d.domain)));
      checked++;
      if (used <= limit.minutes * MIN) kept++;
    }
  }

  const rows = new Map<string, SiteChange>();
  const row = (domain: string) => {
    const r = rows.get(domain) ?? { domain, thisWeekMs: 0, lastWeekMs: 0 };
    rows.set(domain, r);
    return r;
  };
  for (const d of thisDays.flatMap((day) => day.domains)) row(d.domain).thisWeekMs += d.activeMs;
  for (const d of lastDays.flatMap((day) => day.domains)) row(d.domain).lastWeekMs += d.activeMs;
  const change = (r: SiteChange) => r.thisWeekMs - r.lastWeekMs;
  const byDomain = (a: SiteChange, b: SiteChange) => a.domain.localeCompare(b.domain);
  const all = [...rows.values()];

  return {
    thisWeek: weekTotals(thisDays, list),
    lastWeek: weekTotals(lastDays, list),
    limits: { kept, checked },
    increases: all
      .filter((r) => change(r) > 0)
      .sort((a, b) => change(b) - change(a) || byDomain(a, b))
      .slice(0, TOP_CHANGES),
    decreases: all
      .filter((r) => change(r) < 0)
      .sort((a, b) => change(a) - change(b) || byDomain(a, b))
      .slice(0, TOP_CHANGES),
  };
}
