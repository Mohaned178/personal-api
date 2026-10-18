import { z } from "zod";
import { safeMessage } from "./errors.js";
import { DEFAULT_POLICIES } from "./integrations.js";
import { ruleSchema } from "./rules.js";
import { RULES_PER_USER_MAX } from "./rules-api.js";

const COLLECT_ONLY = safeMessage("Only collect-stage rules belong in the extension config");
const UNIQUE_IDS = safeMessage("Duplicate rule id");

/**
 * Response of `GET /v1/ingest/config` (PLAN §6, M4-06): what the extension needs to decide what to
 * collect. `rules` holds the user's enabled `collect`-stage rules only: `process` rules run on the
 * server, and a disabled rule is never evaluated. `defaultPolicy` is the integration's own policy,
 * so a change to it changes the ETag. `ruleSetVersion` is what the extension stamps on its events
 * (`meta.ruleSetVersion`); version 0 means the user has no rules yet (nothing is collected under
 * the default `deny` policy).
 *
 * The extension validates the body with this schema and then compiles the rules with the engine;
 * if either fails it collects nothing (invariant 1). Strict, like the rule format.
 */
export const ingestConfigResponseSchema = z
  .strictObject({
    ruleSetVersion: z.int().min(0),
    defaultPolicy: z.enum(DEFAULT_POLICIES),
    rules: z.array(ruleSchema).max(RULES_PER_USER_MAX),
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
  });
export type IngestConfigResponse = z.output<typeof ingestConfigResponseSchema>;
