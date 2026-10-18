import type { Rule } from "@personal-api/contracts";
import type { CompiledRuleSet } from "./types.js";

/** `coarsen` only ever rewrites this field. */
const COARSENED_FIELD = "data.path";

const verdicts = new WeakMap<CompiledRuleSet, boolean>();

function conditionFields(rule: Rule): string[] {
  const { all = [], any = [], none = [] } = rule.when;
  return [...all, ...any, ...none].map((condition) => condition.field);
}

function compute(ruleSet: CompiledRuleSet): boolean {
  const rewritten = new Set<string>();
  for (const rule of ruleSet.collect) {
    for (const action of rule.then) {
      if (action.action === "coarsen") rewritten.add(COARSENED_FIELD);
      if (action.action === "redact") rewritten.add(action.field);
    }
  }
  if (rewritten.size === 0) return false;
  return ruleSet.collect.some(
    (rule) =>
      rule.then.some((action) => action.action === "allow") &&
      conditionFields(rule).some((field) => rewritten.has(field)),
  );
}

/**
 * Whether `context.collected` may be passed for events of this rule set (the server only; PLAN §3
 * and `docs/rule-format.md`, open item 1).
 *
 * `collected` lets through an event that no collect rule decides, so it skips the default policy.
 * That is only needed when an `allow` rule reads a field that a collect transform rewrites
 * (`data.path` with any `coarsen`, or a field some `redact` removes): the extension's own output
 * then stops matching the rule that allowed it. With no such rule a re-evaluation is stable (the
 * M4-03 property), so the shortcut buys nothing and the default policy keeps deciding (invariant 1).
 * The check is deliberately broad (any rewriting rule, not only one that matches the same event),
 * which can only enable the shortcut where it is harmless. Computed once per compiled set.
 */
export function canTrustCollected(ruleSet: CompiledRuleSet): boolean {
  let verdict = verdicts.get(ruleSet);
  if (verdict === undefined) {
    verdict = compute(ruleSet);
    verdicts.set(ruleSet, verdict);
  }
  return verdict;
}
