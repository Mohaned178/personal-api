import { type Rule, ruleSetSchema, toContractIssues } from "@personal-api/contracts";
import type { CompileResult } from "./types.js";

/**
 * Evaluation order: lower `priority` first; at the same priority rules that `drop` go first, so
 * `drop` beats `allow`; then by id so the order never depends on how the rules arrived.
 */
function compareRules(a: Rule, b: Rule): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const aDrops = a.then.some((action) => action.action === "drop");
  const bDrops = b.then.some((action) => action.action === "drop");
  if (aDrops !== bDrops) return aDrops ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Validates a rule set with the contracts schema and prepares it to run: disabled rules are left
 * out, the rest are split by stage and sorted. One invalid rule invalidates the whole set, even a
 * disabled one: a rule is never skipped (PLAN §3, principle 4, fail closed). Never throws, and the
 * issues never contain a rule's values.
 */
export function compileRuleSet(input: unknown): CompileResult {
  try {
    const parsed = ruleSetSchema.safeParse(input);
    if (!parsed.success) return { ok: false, issues: toContractIssues(parsed.error.issues) };
    const enabled = parsed.data.rules.filter((rule) => rule.enabled);
    return {
      ok: true,
      ruleSet: {
        version: parsed.data.version,
        collect: enabled.filter((rule) => rule.stage === "collect").sort(compareRules),
        process: enabled.filter((rule) => rule.stage === "process").sort(compareRules),
      },
    };
  } catch {
    return { ok: false, issues: [{ path: [], message: "The rule set could not be read" }] };
  }
}
