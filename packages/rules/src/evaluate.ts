import {
  CLIENT_DECIDER,
  DEFAULT_POLICY_DECIDER,
  INTEGRATION_KINDS,
  type KnownEvent,
  parseEvent,
  type Rule,
  type RuleTrace,
} from "@personal-api/contracts";
import { whenHolds } from "./match.js";
import { applyTransform, type TransformState } from "./transforms.js";
import type { CompiledRuleSet, DefaultPolicy, EvaluateContext, EvaluationResult } from "./types.js";

type Matched = RuleTrace["matched"];

function decidingAction(rule: Rule): "allow" | "drop" | undefined {
  for (const action of rule.then) {
    if (action.action === "allow" || action.action === "drop") return action.action;
  }
  return undefined;
}

function error(reason: "invalid_context" | "invalid_event" | "invalid_result"): EvaluationResult {
  return { decision: "error", reason };
}

/**
 * Runs the rules on one event (PLAN §5, `docs/rule-format.md`). Pure: no clock, no I/O, no
 * randomness, so the extension and the server give the same answer.
 *
 * - `collect` rules run in order. The first matching rule with `allow` or `drop` decides; if
 *   none does, `policy` decides (only the exact value `"allow"` collects). `drop` ends the
 *   evaluation. Conditions are checked against the event as it came in, so a rule that coarsens
 *   a path cannot hide it from a later `drop` rule.
 * - With `context.collected` the extension already ran this version's collect stage: an event that
 *   no rule decides is allowed (`decidedBy` is the client), whatever `policy` says.
 * - `redact`, `coarsen` and `keep_query` of every matching rule apply, whichever rule decides.
 * - `process` rules (unless `context.process` is false) run on the event that will be stored.
 *   They add tags and a retention; they cannot decide.
 *
 * It never throws. A bad event, source or rule set, or a transform that would leave an invalid
 * event, is `{ decision: "error" }`: nothing is collected or stored (invariant 1). A dropped
 * result carries no event (invariant 2).
 */
export function evaluate(
  event: unknown,
  ruleSet: CompiledRuleSet,
  policy: DefaultPolicy,
  context: EvaluateContext,
): EvaluationResult {
  try {
    if (!INTEGRATION_KINDS.includes(context.source)) return error("invalid_context");
    const parsed = parseEvent(event);
    if (!parsed.ok) return error("invalid_event");
    const original = parsed.event;
    const source = context.source;
    const version = ruleSet.version;

    const matched: Matched = [];
    const working: Record<string, unknown> = { ...original.data };
    const state: TransformState = { keepQuery: false };
    let decision: "allow" | "drop" | undefined;
    let decidedBy: string = DEFAULT_POLICY_DECIDER;

    for (const rule of ruleSet.collect) {
      if (!whenHolds(rule.when, original, source)) continue;
      matched.push({ ruleId: rule.id, actions: rule.then.map((action) => action.action) });
      const deciding = decidingAction(rule);
      if (decision === undefined && deciding !== undefined) {
        decision = deciding;
        decidedBy = rule.id;
        if (decision === "drop") {
          return { decision: "drop", trace: { ruleSetVersion: version, matched, decidedBy } };
        }
      }
      for (const action of rule.then) applyTransform(action, working, state);
    }

    if (decision === undefined) {
      if (context.collected === true) {
        decidedBy = CLIENT_DECIDER;
      } else if (policy !== "allow") {
        return { decision: "drop", trace: { ruleSetVersion: version, matched, decidedBy } };
      }
    }

    const result = parseEvent({ ...original, data: working });
    if (!result.ok) return error("invalid_result");
    const stored: KnownEvent = result.event;

    const tags: string[] = [];
    let retentionDays: number | null = null;
    if (context.process !== false) {
      for (const rule of ruleSet.process) {
        if (!whenHolds(rule.when, stored, source)) continue;
        matched.push({ ruleId: rule.id, actions: rule.then.map((action) => action.action) });
        for (const action of rule.then) {
          if (action.action === "tag") {
            if (!tags.includes(action.tag)) tags.push(action.tag);
          } else if (action.action === "set_retention") {
            retentionDays =
              retentionDays === null ? action.days : Math.min(retentionDays, action.days);
          }
        }
      }
    }

    return {
      decision: "allow",
      event: stored,
      tags,
      retentionDays,
      keepQuery: state.keepQuery,
      trace: { ruleSetVersion: version, matched, decidedBy },
    };
  } catch {
    return { decision: "error", reason: "failed" };
  }
}
