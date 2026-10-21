import { z } from "zod";
import { domainSchema, pathSchema, utcDateTimeSchema } from "./primitives.js";

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
/**
 * Code of the 400 for a `from`/`to` pair that is empty, reversed or wider than the maximum. The
 * service checks the pair after it has filled in a missing end, so every bad range has this code.
 */
export const ACTIVITY_RANGE_INVALID_CODE = "activity.range_invalid";

/** `from` is inclusive and `to` exclusive. Both default: `to` to now and `from` to 7 days before it. */
const rangeShape = {
  from: utcDateTimeSchema.optional(),
  to: utcDateTimeSchema.optional(),
};

export const activityDailyQuerySchema = z.strictObject(rangeShape);
export type ActivityDailyQuery = z.output<typeof activityDailyQuerySchema>;

const limitSchema = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(ACTIVITY_DOMAINS_MAX_LIMIT));

export const activityDomainsQuerySchema = z.strictObject({
  ...rangeShape,
  limit: limitSchema.optional(),
});
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

/**
 * Detailed dashboard (M9-03): one site, the hours of the week, and the list of sessions. A
 * "session" here is one `browser.focus_segment` (one stretch of attention on one page). Days and
 * hours are cut in the user's time zone and counted by `occurred_at`, like the daily totals.
 */

export const ACTIVITY_SITE_PATHS_LIMIT = 10;
export const ACTIVITY_SESSIONS_DEFAULT_LIMIT = 50;
export const ACTIVITY_SESSIONS_MAX_LIMIT = 200;
/** Code of the 400 for a sessions cursor that was not issued by this API. */
export const ACTIVITY_CURSOR_INVALID_CODE = "activity.cursor_invalid";

export const activitySiteQuerySchema = z.strictObject({ ...rangeShape, domain: domainSchema });
export type ActivitySiteQuery = z.output<typeof activitySiteQuerySchema>;

export const activityPathSchema = z.strictObject({
  path: pathSchema,
  activeMs: z.number().int().min(0),
  pageVisits: z.number().int().min(0),
});
export type ActivityPath = z.output<typeof activityPathSchema>;

/**
 * Totals for one domain over the range. `days` leaves out days with no activity. `sessions` counts
 * focus segments; the average and the longest are 0 when there are none. `paths` are the busiest
 * pages, most active time first.
 */
export const activitySiteResponseSchema = z.strictObject({
  domain: domainSchema,
  from: utcDateTimeSchema,
  to: utcDateTimeSchema,
  timeZone: z.string(),
  days: z.array(activityDaySchema),
  activeMs: z.number().int().min(0),
  pageVisits: z.number().int().min(0),
  sessions: z.number().int().min(0),
  averageSessionMs: z.number().int().min(0),
  longestSessionMs: z.number().int().min(0),
  paths: z.array(activityPathSchema).max(ACTIVITY_SITE_PATHS_LIMIT),
});
export type ActivitySiteResponse = z.output<typeof activitySiteResponseSchema>;

export const activityHoursQuerySchema = z.strictObject(rangeShape);
export type ActivityHoursQuery = z.output<typeof activityHoursQuerySchema>;

/** One hour of one weekday (`weekday` 0 is Monday, 6 Sunday; `hour` 0 to 23), summed over the range. */
export const activityHourCellSchema = z.strictObject({
  weekday: z.int().min(0).max(6),
  hour: z.int().min(0).max(23),
  activeMs: z.number().int().min(0),
});
export type ActivityHourCell = z.output<typeof activityHourCellSchema>;

/** Only the cells that have activity. */
export const activityHoursResponseSchema = z.strictObject({
  from: utcDateTimeSchema,
  to: utcDateTimeSchema,
  timeZone: z.string(),
  cells: z.array(activityHourCellSchema),
});
export type ActivityHoursResponse = z.output<typeof activityHoursResponseSchema>;

const sessionsLimitSchema = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(ACTIVITY_SESSIONS_MAX_LIMIT));

/** `cursor` is the opaque `nextCursor` of the previous page (keyset on `(occurred_at, id)`). */
export const activitySessionsQuerySchema = z.strictObject({
  ...rangeShape,
  cursor: z.string().min(1).max(256).optional(),
  limit: sessionsLimitSchema.optional(),
});
export type ActivitySessionsQuery = z.output<typeof activitySessionsQuerySchema>;

export const activitySessionSchema = z.strictObject({
  id: z.uuid(),
  domain: domainSchema,
  startedAt: utcDateTimeSchema,
  endedAt: utcDateTimeSchema,
  durationMs: z.number().int().min(0),
});
export type ActivitySession = z.output<typeof activitySessionSchema>;

/** Newest first. `nextCursor` is null on the last page. */
export const activitySessionsResponseSchema = z.strictObject({
  from: utcDateTimeSchema,
  to: utcDateTimeSchema,
  sessions: z.array(activitySessionSchema),
  nextCursor: z.string().nullable(),
});
export type ActivitySessionsResponse = z.output<typeof activitySessionsResponseSchema>;
