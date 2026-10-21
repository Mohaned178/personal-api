import {
  type Recommendation,
  type RecommendationsResponse,
  recommendationKey,
  SCHEDULE_NAME_MAX,
} from "@personal-api/contracts";
import { createSchedule } from "./blocking";
import { createLimit, replaceLimit } from "./limits";

/**
 * Dashboard calls for /v1/recommendations (M9-04). A failure throws a generic error (no body, URL
 * or domain in the message), and nothing here logs. Applying a suggestion goes through the limits
 * routes; dismissals stay in this browser and are cleared on sign-out.
 */
export type { Recommendation };
export { recommendationKey };

/** `23:00`, the contract's time of day. */
export const hourLabel = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;

export async function getRecommendations(): Promise<Recommendation[]> {
  const res = await fetch("/v1/recommendations", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Request failed (${res.status}).`);
  return ((await res.json()) as RecommendationsResponse).recommendations;
}

/**
 * Turns a suggestion into limits (the plan's first step, or the next step down of a kept limit) or,
 * for a late-night hint, into a schedule that blocks the site in those hours every day (M9-06).
 */
export async function applyRecommendation(r: Recommendation): Promise<void> {
  if (r.kind === "limit_plan") {
    await createLimit({ pattern: r.domain, minutes: r.steps[0] as number, strict: false });
  } else if (r.kind === "limit_step") {
    await replaceLimit(r.limitId, {
      pattern: r.pattern,
      minutes: r.nextMinutes,
      strict: r.strict,
    });
  } else {
    await createSchedule({
      name: `${r.domain} at night`.slice(0, SCHEDULE_NAME_MAX),
      patterns: [r.domain],
      days: [0, 1, 2, 3, 4, 5, 6],
      start: hourLabel(r.fromHour),
      end: hourLabel(r.toHour),
      enabled: true,
    });
  }
}

const DISMISSED_KEY = "personal-api.dismissed-recommendations";

export function readDismissed(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

export function saveDismissed(keys: string[]): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(keys));
  } catch {
    // Storage can be blocked; the suggestion is then hidden until the page reloads.
  }
}

export function clearDismissed(): void {
  try {
    window.localStorage.removeItem(DISMISSED_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}
