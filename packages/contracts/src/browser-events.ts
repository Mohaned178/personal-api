import { z } from "zod";
import { safeMessage } from "./errors.js";
import { domainSchema, pathSchema, tabRefSchema, utcDateTimeSchema } from "./primitives.js";

/**
 * Payload (`data`) schemas for the v1 browser event types (PLAN §4). Every schema is strict:
 * unknown keys are rejected, so titles, full URLs, query strings and server-owned fields
 * (`userId`, `integrationId`, `receivedAt`, `origin`) can never ride along.
 */

/** Chrome's `TransitionType` values (chrome.webNavigation / history). */
export const PAGE_TRANSITIONS = [
  "link",
  "typed",
  "auto_bookmark",
  "auto_subframe",
  "manual_subframe",
  "generated",
  "auto_toplevel",
  "form_submit",
  "reload",
  "keyword",
  "keyword_generated",
] as const;

export const pageVisitedV1Schema = z.strictObject({
  domain: domainSchema,
  path: pathSchema,
  transition: z.enum(PAGE_TRANSITIONS).optional(),
  tabRef: tabRefSchema,
});
export type PageVisitedV1 = z.output<typeof pageVisitedV1Schema>;

/** Longest accepted focus segment. Longer intervals are runaway durations, so they are rejected. */
export const FOCUS_SEGMENT_MAX_MS = 30 * 60 * 1000;

const ENDED_BEFORE_STARTED = safeMessage("endedAt is before startedAt");
const DURATION_MISMATCH = safeMessage("durationMs does not match endedAt minus startedAt");

export const focusSegmentV1Schema = z
  .strictObject({
    domain: domainSchema,
    path: pathSchema,
    startedAt: utcDateTimeSchema,
    endedAt: utcDateTimeSchema,
    durationMs: z.int().min(0).max(FOCUS_SEGMENT_MAX_MS),
  })
  .superRefine((segment, ctx) => {
    // Runs only once the fields above are valid.
    const span = Date.parse(segment.endedAt) - Date.parse(segment.startedAt);
    if (span < 0) {
      ctx.addIssue({ code: "custom", path: ["endedAt"], message: ENDED_BEFORE_STARTED });
      return;
    }
    if (span !== segment.durationMs) {
      ctx.addIssue({
        code: "custom",
        path: ["durationMs"],
        message: DURATION_MISMATCH,
      });
    }
  });
export type FocusSegmentV1 = z.output<typeof focusSegmentV1Schema>;

export const tabOpenedV1Schema = z.strictObject({
  tabRef: tabRefSchema,
  domain: domainSchema.optional(),
});
export type TabOpenedV1 = z.output<typeof tabOpenedV1Schema>;

export const tabClosedV1Schema = z.strictObject({
  tabRef: tabRefSchema,
  domain: domainSchema.optional(),
});
export type TabClosedV1 = z.output<typeof tabClosedV1Schema>;

/** `resume`: the service worker found a browser session already running after a restart. */
export const SESSION_START_REASONS = ["startup", "resume"] as const;

/** `recovered`: the session was closed after the fact (browser crash or killed worker). */
export const SESSION_END_REASONS = ["idle", "lock", "shutdown", "recovered"] as const;

export const sessionStartedV1Schema = z.strictObject({
  reason: z.enum(SESSION_START_REASONS),
});
export type SessionStartedV1 = z.output<typeof sessionStartedV1Schema>;

export const sessionEndedV1Schema = z.strictObject({
  reason: z.enum(SESSION_END_REASONS),
});
export type SessionEndedV1 = z.output<typeof sessionEndedV1Schema>;
