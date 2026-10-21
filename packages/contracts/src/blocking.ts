import { z } from "zod";
import { safeMessage } from "./errors.js";
import { utcDateTimeSchema } from "./primitives.js";
import { domainPatternSchema } from "./rules.js";

/**
 * Focus mode and schedules (M9-06). Both block sites on the device: the extension gets them with
 * the rules (`GET /v1/ingest/config`, like limits) and moves a tab on a blocked site to its
 * "Time's up" page, with no override. The server only stores them. A focus session is one-off
 * (`/v1/focus`, one per user, until `endsAt`); a schedule repeats on chosen weekdays between two
 * times of day in the device's local time (`/v1/schedules`). Session routes only.
 *
 * Requests are strict: the server sets the id, the owner and the end time (invariant 4). Issue
 * messages are fixed strings (invariant 6): a pattern is a domain the user browses.
 */

/** Most sites one focus session or one schedule blocks. */
export const BLOCK_PATTERNS_MAX = 20;
/** Most schedules one user can have. Creating more is a 409. */
export const SCHEDULES_PER_USER_MAX = 20;
export const SCHEDULE_NAME_MAX = 60;
export const FOCUS_MIN_MINUTES = 1;
/** Eight hours. A longer block is a schedule. */
export const FOCUS_MAX_MINUTES = 8 * 60;

/** `DELETE /v1/focus` with no session to end. */
export const FOCUS_NOT_FOUND_CODE = "focus.not_found";
export const SCHEDULE_NOT_FOUND_CODE = "schedule.not_found";
export const SCHEDULE_LIMIT_REACHED_CODE = "schedule.limit_reached";

const UNIQUE_PATTERNS = safeMessage("Duplicate site");
const UNIQUE_DAYS = safeMessage("Duplicate day");
const SAME_TIMES = safeMessage("A schedule needs different start and end times");

const patternsSchema = z
  .array(domainPatternSchema)
  .min(1)
  .max(BLOCK_PATTERNS_MAX)
  .refine((patterns) => new Set(patterns).size === patterns.length, { message: UNIQUE_PATTERNS });

/** `HH:MM`, 24 hours, in the device's local time. */
export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** What a user submits to start a focus session. */
export const focusStartSchema = z.strictObject({
  patterns: patternsSchema,
  minutes: z.int().min(FOCUS_MIN_MINUTES).max(FOCUS_MAX_MINUTES),
});
export type FocusStart = z.output<typeof focusStartSchema>;

/** A running focus session. `endsAt` is an absolute instant (ISO 8601, UTC). */
export const focusSessionSchema = z.strictObject({
  id: z.uuid(),
  patterns: patternsSchema,
  endsAt: utcDateTimeSchema,
});
export type FocusSession = z.output<typeof focusSessionSchema>;

/** `GET /v1/focus` and `POST /v1/focus`: the running session, or `null`. */
export const focusResponseSchema = z.strictObject({ session: focusSessionSchema.nullable() });
export type FocusResponse = z.output<typeof focusResponseSchema>;

const scheduleFields = {
  name: z.string().trim().min(1).max(SCHEDULE_NAME_MAX),
  patterns: patternsSchema,
  /** 0 = Monday … 6 = Sunday, the weekday the block STARTS on. */
  days: z
    .array(z.int().min(0).max(6))
    .min(1)
    .max(7)
    .refine((days) => new Set(days).size === days.length, { message: UNIQUE_DAYS }),
  start: timeOfDaySchema,
  /** Earlier than `start` means it ends the next morning (`23:00` to `07:00`). */
  end: timeOfDaySchema,
};

/** What a user submits to create or replace a schedule. */
export const scheduleSaveSchema = z
  .strictObject({ ...scheduleFields, enabled: z.boolean().default(true) })
  .refine((schedule) => schedule.start !== schedule.end, {
    path: ["end"],
    message: SAME_TIMES,
  });
export type ScheduleSave = z.output<typeof scheduleSaveSchema>;

/** A stored schedule. */
export const scheduleSchema = z
  .strictObject({ id: z.uuid(), ...scheduleFields, enabled: z.boolean() })
  .refine((schedule) => schedule.start !== schedule.end, {
    path: ["end"],
    message: SAME_TIMES,
  });
export type Schedule = z.output<typeof scheduleSchema>;

/** `GET /v1/schedules`: every schedule, by name. */
export const scheduleListResponseSchema = z.strictObject({
  schedules: z.array(scheduleSchema).max(SCHEDULES_PER_USER_MAX),
});
export type ScheduleListResponse = z.output<typeof scheduleListResponseSchema>;
