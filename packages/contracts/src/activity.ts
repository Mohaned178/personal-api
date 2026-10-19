import { z } from "zod";
import { safeMessage } from "./errors.js";
import { domainSchema, utcDateTimeSchema } from "./primitives.js";

/**
 * Activity aggregates (PLAN §6, `GET /v1/activity/daily` and `/domains`). Time is the sum of
 * `browser.focus_segment` durations (each already capped at 30 minutes); visits count
 * `browser.page_visited`. An event counts toward the day (in the user's time zone) of its
 * `occurred_at`, so a segment that crosses midnight is not split. Requests are strict.
 */

export const ACTIVITY_DEFAULT_DAYS = 7;
export const ACTIVITY_MAX_DAYS = 90;
export const ACTIVITY_DOMAINS_DEFAULT_LIMIT = 20;
export const ACTIVITY_DOMAINS_MAX_LIMIT = 100;
/** Code of the 400 for a `from`/`to` pair that is empty, reversed or wider than the maximum. */
export const ACTIVITY_RANGE_INVALID_CODE = "activity.range_invalid";

const DAY_MS = 24 * 60 * 60 * 1000;

/** `from` is inclusive and `to` exclusive. Both default: `to` to now and `from` to 7 days before it. */
const rangeShape = {
  from: utcDateTimeSchema.optional(),
  to: utcDateTimeSchema.optional(),
};

/** Only the two given ends can be checked here; the server fills in a missing one first. */
function rangeIsValid(range: { from?: string | undefined; to?: string | undefined }): boolean {
  if (range.from === undefined || range.to === undefined) return true;
  const span = Date.parse(range.to) - Date.parse(range.from);
  return span > 0 && span <= ACTIVITY_MAX_DAYS * DAY_MS;
}
const rangeRefinement = {
  message: safeMessage(`Expected from before to, at most ${ACTIVITY_MAX_DAYS} days apart`),
};

export const activityDailyQuerySchema = z
  .strictObject(rangeShape)
  .refine(rangeIsValid, rangeRefinement);
export type ActivityDailyQuery = z.output<typeof activityDailyQuerySchema>;

const limitSchema = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(ACTIVITY_DOMAINS_MAX_LIMIT));

export const activityDomainsQuerySchema = z
  .strictObject({ ...rangeShape, limit: limitSchema.optional() })
  .refine(rangeIsValid, rangeRefinement);
export type ActivityDomainsQuery = z.output<typeof activityDomainsQuerySchema>;

/** One local day that has activity. Days with none are left out. */
export const activityDaySchema = z.strictObject({
  /** `YYYY-MM-DD` in `timeZone`. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  activeMs: z.number().int().min(0),
  pageVisits: z.number().int().min(0),
});
export type ActivityDay = z.output<typeof activityDaySchema>;

export const activityDailyResponseSchema = z.strictObject({
  from: utcDateTimeSchema,
  to: utcDateTimeSchema,
  timeZone: z.string(),
  days: z.array(activityDaySchema),
});
export type ActivityDailyResponse = z.output<typeof activityDailyResponseSchema>;

export const activityDomainSchema = z.strictObject({
  domain: domainSchema,
  activeMs: z.number().int().min(0),
  pageVisits: z.number().int().min(0),
});
export type ActivityDomain = z.output<typeof activityDomainSchema>;

/** Most active time first, then most visits, then domain name. */
export const activityDomainsResponseSchema = z.strictObject({
  from: utcDateTimeSchema,
  to: utcDateTimeSchema,
  domains: z.array(activityDomainSchema),
});
export type ActivityDomainsResponse = z.output<typeof activityDomainsResponseSchema>;
