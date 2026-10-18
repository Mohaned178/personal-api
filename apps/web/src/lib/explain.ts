import type { Rule, RuleTrace } from "@personal-api/contracts";
import { CLIENT_DECIDER, DEFAULT_POLICY_DECIDER } from "@personal-api/contracts";

/**
 * "Why is this here": turns the trace stored with an event into plain sentences. The trace holds
 * rule ids and action names only, so rule names come from the user's current rules; a rule that
 * was deleted since is named as such. Pure, with no I/O.
 */

export interface TraceExplanation {
  /** One sentence: what decided the event, in words. */
  decision: string;
  /** Every rule that matched, with the actions it contributed. */
  matched: { ruleId: string; label: string; actions: string[]; decided: boolean }[];
  /** Set when the rules have changed since the event was stored. */
  staleNote: string | null;
}

const GONE = "A rule that no longer exists";

export function explainTrace(
  trace: RuleTrace | null,
  rules: readonly Rule[] | undefined,
  currentVersion: number | undefined,
): TraceExplanation {
  if (!trace) {
    return {
      decision: "This event was stored before rules existed, so there is no record of why.",
      matched: [],
      staleNote: null,
    };
  }
  const names = new Map((rules ?? []).map((rule) => [rule.id, rule.name]));
  // Without the rules list we cannot tell a deleted rule from one we failed to load.
  const label = (ruleId: string) => names.get(ruleId) ?? (rules ? GONE : "A rule");

  let decision: string;
  if (trace.decidedBy === DEFAULT_POLICY_DECIDER) {
    decision = "No rule decided, so the integration's default policy let it through.";
  } else if (trace.decidedBy === CLIENT_DECIDER) {
    decision =
      "The extension had already applied your rules to it, and no further rule on the server decided otherwise.";
  } else {
    decision = `Kept because of the rule “${label(trace.decidedBy)}”.`;
  }

  const staleNote =
    currentVersion !== undefined && currentVersion > trace.ruleSetVersion
      ? `Your rules have changed since (this event was stored under version ${trace.ruleSetVersion}, the current version is ${currentVersion}), so the rule names and settings shown here may differ from what applied then.`
      : null;

  return {
    decision,
    matched: trace.matched.map((m) => ({
      ruleId: m.ruleId,
      label: label(m.ruleId),
      actions: m.actions,
      decided: m.ruleId === trace.decidedBy,
    })),
    staleNote,
  };
}
