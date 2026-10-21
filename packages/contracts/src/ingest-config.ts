import { z } from "zod";
import { focusSessionSchema, SCHEDULES_PER_USER_MAX, scheduleSchema } from "./blocking.js";
import { safeMessage } from "./errors.js";
import { DEFAULT_POLICIES } from "./integrations.js";
import { LIMITS_PER_USER_MAX, limitSchema } from "./limits.js";
import { ruleSchema } from "./rules.js";
import { RULES_PER_USER_MAX } from "./rules-api.js";

const COLLECT_ONLY = safeMessage("Only collect-stage rules belong in the extension config");
const UNIQUE_IDS = safeMessage("Duplicate rule id");
const UNIQUE_LIMITS = safeMessage("Duplicate limit");
const UNIQUE_SCHEDULES = safeMessage("Duplicate schedule");

/**
 * Response of `GET /v1/ingest/config` (PLAN §6, M4-06): what the extension needs to decide what to
 * collect. `rules` holds the user's enabled `collect`-stage rules only: `process` rules run on the
 * server, and a disabled rule is never evaluated. `defaultPolicy` is the integration's own policy,
 * so a change to it changes the ETag. `ruleSetVersion` is what the extension stamps on its events
 * (`meta.ruleSetVersion`); version 0 means the user has no rules yet (nothing is collected under
 * the default `deny` policy). `limits` (M9-02) are the user's daily site limits, which the extension
 * enforces on the device; they do not move `ruleSetVersion`, and a change still changes the ETag.
 * A config stored before limits existed has none, so `limits` defaults to an empty list.
 * `focus` (the running focus session, M9-06) and `schedules` (the enabled ones) are blocks the
 * extension enforces the same way; they default to none and a change still changes the ETag.
 *
 * The extension validates the body with this schema and then compiles the rules with the engine;
 * if either fails it collects nothing (invariant 1). Strict, like the rule format.
 */
export const ingestConfigResponseSchema = z
  .strictObject({
    ruleSetVersion: z.int().min(0),
    defaultPolicy: z.enum(DEFAULT_POLICIES),
    rules: z.array(ruleSchema).max(RULES_PER_USER_MAX),
    limits: z.array(limitSchema).max(LIMITS_PER_USER_MAX).default([]),
    focus: focusSessionSchema.nullable().default(null),
    schedules: z.array(scheduleSchema).max(SCHEDULES_PER_USER_MAX).default([]),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.rules.forEach((rule, index) => {
      if (rule.stage !== "collect") {
        ctx.addIssue({ code: "custom", path: ["rules", index, "stage"], message: COLLECT_ONLY });
      }
      if (seen.has(rule.id)) {
        ctx.addIssue({ code: "custom", path: ["rules", index, "id"], message: UNIQUE_IDS });
      }
      seen.add(rule.id);
    });
    const limitIds = new Set<string>();
    const limitPatterns = new Set<string>();
    config.limits.forEach((limit, index) => {
      if (limitIds.has(limit.id) || limitPatterns.has(limit.pattern)) {
        ctx.addIssue({ code: "custom", path: ["limits", index], message: UNIQUE_LIMITS });
      }
      limitIds.add(limit.id);
      limitPatterns.add(limit.pattern);
    });
    const scheduleIds = new Set<string>();
    config.schedules.forEach((schedule, index) => {
      if (scheduleIds.has(schedule.id)) {
        ctx.addIssue({ code: "custom", path: ["schedules", index], message: UNIQUE_SCHEDULES });
      }
      scheduleIds.add(schedule.id);
    });
  });
export type IngestConfigResponse = z.output<typeof ingestConfigResponseSchema>;
