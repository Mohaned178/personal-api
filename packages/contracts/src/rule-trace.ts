import { z } from "zod";
import { RULE_ACTION_NAMES } from "./rules.js";

/** `decidedBy` when no rule decided and the integration's default policy did. */
export const DEFAULT_POLICY_DECIDER = "default_policy";

/**
 * `decidedBy` when the extension had already run this rule-set version's collect stage and no
 * server collect rule decided, so the server let the event through (`docs/rule-format.md`,
 * open item 1). Never written for an event the server evaluated in full.
 */
export const CLIENT_DECIDER = "client";

/**
 * Why an event was kept or dropped (PLAN §5). Stored with each event and shown by "why is this
 * here". It lists action **names** only, never their parameters, so a trace cannot hold a domain,
 * a path or a tag. The server builds it; it is never accepted from a client.
 */
export const ruleTraceSchema = z.strictObject({
  ruleSetVersion: z.int().min(0),
  matched: z.array(
    z.strictObject({
      ruleId: z.uuid(),
      actions: z.array(z.enum(RULE_ACTION_NAMES)),
    }),
  ),
  decidedBy: z.union([z.uuid(), z.literal(DEFAULT_POLICY_DECIDER), z.literal(CLIENT_DECIDER)]),
});
export type RuleTrace = z.output<typeof ruleTraceSchema>;
