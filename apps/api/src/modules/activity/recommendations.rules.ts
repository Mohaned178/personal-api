import {
  globMatches,
  type Limit,
  RECOMMENDATIONS_MAX,
  type Recommendation,
} from "@personal-api/contracts";

/** Active time on one domain on one local day, and the part of it that fell at night (23:00-07:00). */
export interface DomainDay {
  domain: string;
  /** `YYYY-MM-DD` in the user's time zone. */
  date: string;
  activeMs: number;
  nightMs: number;
}

export interface RecommendationInput {
  /** Domain-days of the last 4 weeks. */
  days: DomainDay[];
  limits: Limit[];
  /** Days from the user's first activity in the window to now. Less than `MIN_DATA_DAYS`: no advice. */
  dataSpanDays: number;
  /** First local date of the last 7 days (`YYYY-MM-DD`). */
  recentFrom: string;
}

const MINUTE_MS = 60_000;
const STEP_MINUTES = 15;
export const MIN_DATA_DAYS = 14;
const PLAN_MIN_ACTIVE_DAYS = 10;
const PLAN_MIN_AVERAGE_MINUTES = 45;
const PLAN_MAX_STEPS = 4;
/** No plan or step goes under this: below half an hour a limit is a block. */
const FLOOR_MINUTES = 30;
const STEP_MIN_ACTIVE_DAYS = 5;
const NIGHT_MIN_SHARE = 0.5;
const NIGHT_MIN_MS = 3 * 60 * MINUTE_MS;
const NIGHT_MIN_DAYS = 4;
export const NIGHT_FROM_HOUR = 23;
export const NIGHT_TO_HOUR = 7;

/**
 * Pure and deterministic: the same input gives the same suggestions, in a fixed order (steps down
 * first, then plans, then late-night hints). Not enough data gives none.
 */
export function recommend(input: RecommendationInput): Recommendation[] {
  if (input.dataSpanDays < MIN_DATA_DAYS) return [];
  return [...stepDowns(input), ...plans(input), ...lateNight(input)].slice(0, RECOMMENDATIONS_MAX);
}

interface Totals {
  activeMs: number;
  nightMs: number;
  activeDays: number;
  nightDays: number;
}

function totalsByDomain(days: DomainDay[]): Map<string, Totals> {
  const out = new Map<string, Totals>();
  for (const d of days) {
    if (d.activeMs <= 0) continue;
    const t = out.get(d.domain) ?? { activeMs: 0, nightMs: 0, activeDays: 0, nightDays: 0 };
    t.activeMs += d.activeMs;
    t.nightMs += d.nightMs;
    t.activeDays += 1;
    if (d.nightMs > 0) t.nightDays += 1;
    out.set(d.domain, t);
  }
  return out;
}

function plans({ days, limits }: RecommendationInput): Recommendation[] {
  const found: { domain: string; average: number; steps: number[] }[] = [];
  for (const [domain, t] of totalsByDomain(days)) {
    if (t.activeDays < PLAN_MIN_ACTIVE_DAYS) continue;
    if (limits.some((l) => globMatches(l.pattern, domain))) continue;
    const average = t.activeMs / t.activeDays / MINUTE_MS;
    if (average < PLAN_MIN_AVERAGE_MINUTES) continue;
    const start = Math.floor(average / STEP_MINUTES) * STEP_MINUTES;
    const end = Math.max(FLOOR_MINUTES, Math.round((start * 2) / 3 / STEP_MINUTES) * STEP_MINUTES);
    const steps: number[] = [];
    for (let m = start; m >= end && steps.length < PLAN_MAX_STEPS; m -= STEP_MINUTES) steps.push(m);
    if (steps.length < 2 || start > 1440) continue;
    found.push({ domain, average, steps });
  }
  found.sort((a, b) => b.average - a.average || (a.domain < b.domain ? -1 : 1));
  return found.map((f) => ({
    kind: "limit_plan" as const,
    domain: f.domain,
    averageMinutes: Math.round(f.average),
    steps: f.steps,
  }));
}

/**
 * A limit the user kept: the last 7 days have at least 5 active days and none went over it. A
 * limit set this week still has days from before it, so it is not suggested again at once.
 */
function stepDowns({ days, limits, recentFrom }: RecommendationInput): Recommendation[] {
  const found: Extract<Recommendation, { kind: "limit_step" }>[] = [];
  for (const limit of limits) {
    const nextMinutes = limit.minutes - STEP_MINUTES;
    if (nextMinutes < FLOOR_MINUTES) continue;
    const perDay = new Map<string, number>();
    for (const d of days) {
      if (d.date < recentFrom || d.activeMs <= 0 || !globMatches(limit.pattern, d.domain)) continue;
      perDay.set(d.date, (perDay.get(d.date) ?? 0) + d.activeMs);
    }
    if (perDay.size < STEP_MIN_ACTIVE_DAYS) continue;
    if ([...perDay.values()].some((ms) => ms > limit.minutes * MINUTE_MS)) continue;
    found.push({
      kind: "limit_step",
      limitId: limit.id,
      pattern: limit.pattern,
      strict: limit.strict,
      currentMinutes: limit.minutes,
      nextMinutes,
    });
  }
  return found.sort((a, b) => (a.pattern < b.pattern ? -1 : 1));
}

function lateNight({ days }: RecommendationInput): Recommendation[] {
  const found: { domain: string; share: number; nightMs: number }[] = [];
  for (const [domain, t] of totalsByDomain(days)) {
    if (t.nightMs < NIGHT_MIN_MS || t.nightDays < NIGHT_MIN_DAYS) continue;
    const share = t.nightMs / t.activeMs;
    if (share < NIGHT_MIN_SHARE) continue;
    found.push({ domain, share, nightMs: t.nightMs });
  }
  found.sort((a, b) => b.nightMs - a.nightMs || (a.domain < b.domain ? -1 : 1));
  return found.map((f) => ({
    kind: "late_night" as const,
    domain: f.domain,
    sharePercent: Math.min(100, Math.round(f.share * 100)),
    fromHour: NIGHT_FROM_HOUR,
    toHour: NIGHT_TO_HOUR,
  }));
}
