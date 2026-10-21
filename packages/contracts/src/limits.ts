import { z } from "zod";
import { domainPatternSchema } from "./rules.js";

/**
 * Daily site limits (M9-02, `/v1/limits`, session only). A limit is a domain pattern plus minutes
 * per day. The extension gets the user's limits with its rules (`GET /v1/ingest/config`) and
 * enforces them on the device from its own totals. `strict` turns off "5 more minutes": there is
 * no override until the user's local midnight.
 *
 * Requests are strict: the server sets the id and the owner (invariant 4). Issue messages are
 * fixed strings (invariant 6): a pattern is a domain the user browses.
 */

/** Most limits one user can have. Creating more is a 409. */
export const LIMITS_PER_USER_MAX = 50;
export const LIMIT_MIN_MINUTES = 1;
/** A day. A longer limit would never be reached. */
export const LIMIT_MAX_MINUTES = 24 * 60;

/** Codes of the problem+json answers. An unknown, foreign and malformed id all look the same. */
export const LIMIT_NOT_FOUND_CODE = "limit.not_found";
export const LIMIT_LIMIT_REACHED_CODE = "limit.limit_reached";
export const LIMIT_PATTERN_TAKEN_CODE = "limit.pattern_taken";

/** What a user submits to create or replace a limit. */
export const limitSaveSchema = z.strictObject({
  /** `example.com` (exactly that site) or `*.example.com` (its subdomains, not the apex). */
  pattern: domainPatternSchema,
  minutes: z.int().min(LIMIT_MIN_MINUTES).max(LIMIT_MAX_MINUTES),
  strict: z.boolean().default(false),
});
export type LimitSave = z.output<typeof limitSaveSchema>;

/** A stored limit. */
export const limitSchema = z.strictObject({
  id: z.uuid(),
  pattern: domainPatternSchema,
  minutes: z.int().min(LIMIT_MIN_MINUTES).max(LIMIT_MAX_MINUTES),
  strict: z.boolean(),
});
export type Limit = z.output<typeof limitSchema>;

/** `GET /v1/limits`: every limit, by pattern. */
export const limitListResponseSchema = z.strictObject({
  limits: z.array(limitSchema).max(LIMITS_PER_USER_MAX),
});
export type LimitListResponse = z.output<typeof limitListResponseSchema>;
