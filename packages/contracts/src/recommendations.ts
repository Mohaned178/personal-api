import { z } from "zod";
import { domainSchema, utcDateTimeSchema } from "./primitives.js";
import { domainPatternSchema } from "./rules.js";

/**
 * Recommendations (M9-04, `GET /v1/recommendations`, session only). A deterministic rule set over
 * the user's own last 4 weeks, with no AI and no outside service. The server only suggests; the
 * dashboard applies a suggestion through the existing `/v1/limits` routes. Dismissals stay in the
 * browser. Nothing here is logged: every field is a domain or a number from the user's data.
 */

export const RECOMMENDATIONS_WINDOW_DAYS = 28;
/** The most suggestions one answer carries. */
export const RECOMMENDATIONS_MAX = 6;

/** A heavy site: a stepped limit plan, `steps` being minutes per day, one step a week, first to last. */
export const limitPlanRecommendationSchema = z.strictObject({
  kind: z.literal("limit_plan"),
  domain: domainSchema,
  /** Average active minutes on the days the site was used. */
  averageMinutes: z.int().min(0),
  steps: z.array(z.int().min(1).max(1440)).min(2).max(4),
});

/** A site with a limit the user has kept for a week: the next step down. */
export const limitStepRecommendationSchema = z.strictObject({
  kind: z.literal("limit_step"),
  limitId: z.uuid(),
  pattern: domainPatternSchema,
  strict: z.boolean(),
  currentMinutes: z.int().min(1).max(1440),
  nextMinutes: z.int().min(1).max(1440),
});

/** Most of the time on a site falls late at night (local time). Read-only until schedules exist (M9-06). */
export const lateNightRecommendationSchema = z.strictObject({
  kind: z.literal("late_night"),
  domain: domainSchema,
  /** Share of the site's active time between `fromHour` and `toHour`, in whole percent. */
  sharePercent: z.int().min(0).max(100),
  fromHour: z.int().min(0).max(23),
  toHour: z.int().min(0).max(23),
});

export const recommendationSchema = z.discriminatedUnion("kind", [
  limitPlanRecommendationSchema,
  limitStepRecommendationSchema,
  lateNightRecommendationSchema,
]);
export type Recommendation = z.output<typeof recommendationSchema>;

export const recommendationsResponseSchema = z.strictObject({
  from: utcDateTimeSchema,
  to: utcDateTimeSchema,
  timeZone: z.string(),
  recommendations: z.array(recommendationSchema).max(RECOMMENDATIONS_MAX),
});
export type RecommendationsResponse = z.output<typeof recommendationsResponseSchema>;

/** The key a dismissal is remembered under: the same suggestion stays dismissed, a new one does not. */
export function recommendationKey(r: Recommendation): string {
  if (r.kind === "limit_step") return `limit_step:${r.pattern}:${r.nextMinutes}`;
  if (r.kind === "limit_plan") return `limit_plan:${r.domain}`;
  return `late_night:${r.domain}`;
}
