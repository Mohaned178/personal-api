import { z } from "zod";
import { safeMessage } from "./errors.js";

/**
 * User settings (`GET` and `PATCH /v1/settings`, session only). Today that is the IANA time zone
 * the activity aggregates use to cut days. Requests are strict: `userId` never comes from the body.
 */

/**
 * 400 when the database does not know a zone that Node accepts (`Asia/Calcutta`: the system tzdata
 * of the Postgres image has no legacy link names), and 409 when a zone that was saved earlier no
 * longer works in a query. Either way the fix is to pick another zone in the settings.
 */
export const TIME_ZONE_UNSUPPORTED_CODE = "settings.time_zone_unsupported";

export const DEFAULT_TIME_ZONE = "UTC";
export const TIME_ZONE_MAX_LENGTH = 64;

/** Shape only, so a bad name never reaches SQL; `isKnownTimeZone` is the real check on the server. */
const TIME_ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

function isKnownTimeZone(name: string): boolean {
  try {
    // Unlike `Intl.supportedValuesOf`, this also accepts link names such as Asia/Kolkata.
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** An IANA zone name such as `Europe/Berlin` (or `UTC`). Offsets and abbreviations are refused. */
export const timeZoneSchema = z
  .string()
  .max(TIME_ZONE_MAX_LENGTH)
  .regex(TIME_ZONE_PATTERN, safeMessage("Expected an IANA time zone such as Europe/Berlin"))
  .refine(isKnownTimeZone, { message: safeMessage("Unknown time zone") });

export const settingsSchema = z.strictObject({ timeZone: timeZoneSchema });
export type Settings = z.output<typeof settingsSchema>;

export const updateSettingsRequestSchema = z.strictObject({ timeZone: timeZoneSchema });
export type UpdateSettingsRequest = z.output<typeof updateSettingsRequestSchema>;

/**
 * `GET /v1/settings/time-zones` (session only): the names the database accepts, sorted. Every one
 * passes `timeZoneSchema`, so each can be sent back with PATCH.
 */
export const timeZonesResponseSchema = z.strictObject({ timeZones: z.array(timeZoneSchema) });
export type TimeZonesResponse = z.output<typeof timeZonesResponseSchema>;
