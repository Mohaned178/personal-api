import { z } from "zod";
import { safeMessage } from "./errors.js";
import { DEFAULT_POLICIES, INTEGRATION_KINDS } from "./integrations.js";
import { ruleTraceSchema } from "./rule-trace.js";
import { ruleDefinitionSchema, ruleSchema, ruleSetSchema } from "./rules.js";

/**
 * Rules API DTOs (PLAN §6, `/v1/rules`). A rule is submitted as a `RuleDefinition`; the server
 * sets the id and the owner (invariant 4). Requests are strict, like the rule format itself.
 */

/** Most rules one user can have (rule-format open item 3). Creating more is a 409. */
export const RULES_PER_USER_MAX = 100;

/** Code of the 404 for an unknown, foreign or malformed rule id (all look the same). */
export const RULE_NOT_FOUND_CODE = "rule.not_found";
export const RULES_LIMIT_REACHED_CODE = "rules.limit_reached";

/** `GET /v1/rules`: every rule (disabled ones too) at the current version, in evaluation order. */
export const ruleListResponseSchema = ruleSetSchema;
export type RuleListResponse = z.output<typeof ruleListResponseSchema>;

/** A rule after create, read or update. `version` is the rule-set version it is part of. */
export const ruleResponseSchema = z.strictObject({
  rule: ruleSchema,
  version: z.int().min(0),
});
export type RuleResponse = z.output<typeof ruleResponseSchema>;

export const deleteRuleResponseSchema = z.strictObject({ version: z.int().min(0) });
export type DeleteRuleResponse = z.output<typeof deleteRuleResponseSchema>;

const DRAFT_REQUIRED = safeMessage("Needs a draft rule");
const REPLACE_OR_ONLY = safeMessage("Use either replaceRuleId or onlyRule, not both");

/**
 * `POST /v1/rules/test`: a dry run against a sample event. Nothing is stored or counted.
 * `rule` is an unsaved draft. By default it is evaluated together with the saved rules;
 * `replaceRuleId` swaps it in for that saved rule (editing), `onlyRule` evaluates it alone.
 */
export const testRuleRequestSchema = z
  .strictObject({
    event: z.record(z.string(), z.unknown()),
    source: z.enum(INTEGRATION_KINDS),
    defaultPolicy: z.enum(DEFAULT_POLICIES).default("deny"),
    rule: ruleDefinitionSchema.optional(),
    replaceRuleId: z.uuid().optional(),
    onlyRule: z.boolean().optional(),
  })
  .superRefine((request, ctx) => {
    if (request.rule === undefined) {
      for (const key of ["replaceRuleId", "onlyRule"] as const) {
        if (request[key] !== undefined) {
          ctx.addIssue({ code: "custom", path: [key], message: DRAFT_REQUIRED });
        }
      }
    } else if (request.replaceRuleId !== undefined && request.onlyRule === true) {
      ctx.addIssue({ code: "custom", path: ["onlyRule"], message: REPLACE_OR_ONLY });
    }
  });
export type TestRuleRequest = z.output<typeof testRuleRequestSchema>;

/** What the engine decided (`@personal-api/rules` `EvaluationResult`), as the API returns it. */
export const testRuleResponseSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("allow"),
    event: z.record(z.string(), z.unknown()),
    tags: z.array(z.string()),
    retentionDays: z.int().nullable(),
    keepQuery: z.boolean(),
    trace: ruleTraceSchema,
  }),
  z.strictObject({ decision: z.literal("drop"), trace: ruleTraceSchema }),
  z.strictObject({
    decision: z.literal("error"),
    reason: z.enum(["invalid_context", "invalid_event", "invalid_result", "failed"]),
  }),
]);
export type TestRuleResponse = z.output<typeof testRuleResponseSchema>;
