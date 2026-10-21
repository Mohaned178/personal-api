import type { CategoryDay, CategoryRule } from "@personal-api/contracts";
import { classify } from "../categories/classify";
import type { DayRow, DomainDayRow } from "./activity.repository";

/**
 * Splits each day's active time by category (M9-07). `days` are the day totals; `domainDays` the
 * per-site times of the busiest sites, so a site outside that list (a long tail of small sites)
 * stays in the total and ends up in `neutralMs`, never in a category it was not put in. Days are
 * oldest first, as the repository returns them.
 */
export function splitByCategory(
  days: readonly DayRow[],
  domainDays: readonly DomainDayRow[],
  overrides: readonly CategoryRule[],
): CategoryDay[] {
  const categorised = new Map<string, { productiveMs: number; distractingMs: number }>();
  for (const row of domainDays) {
    const category = classify(row.domain, overrides);
    if (category === "neutral") continue;
    const sums = categorised.get(row.date) ?? { productiveMs: 0, distractingMs: 0 };
    if (category === "productive") sums.productiveMs += row.activeMs;
    else sums.distractingMs += row.activeMs;
    categorised.set(row.date, sums);
  }
  return days
    .filter((day) => day.activeMs > 0)
    .map((day) => {
      const sums = categorised.get(day.date) ?? { productiveMs: 0, distractingMs: 0 };
      // Clamp: a total can never be smaller than its parts, but never trust the arithmetic.
      const productiveMs = Math.min(sums.productiveMs, day.activeMs);
      const distractingMs = Math.min(sums.distractingMs, day.activeMs - productiveMs);
      return {
        date: day.date,
        productiveMs,
        distractingMs,
        neutralMs: day.activeMs - productiveMs - distractingMs,
      };
    });
}
