// M4-06 the popup's "this page" line: would the current tab be collected, and which rule says so.
// It asks the same engine with the same stored rules as capture does (a `page_visited` probe for
// the sanitized page), so the popup cannot disagree with what is collected. It never shows the URL.

import { evaluate } from "@personal-api/rules";
import { sanitizeUrl } from "../sanitize-url";
import type { ActiveRules } from "./active-rules";
import { probeEvents } from "./gate";

export type VerdictReason = { by: "rule"; ruleName: string } | { by: "default_policy" };

export type TabVerdict =
  /** No active tab, or a page that is never collected (browser pages, extension pages, files). */
  | { kind: "unsupported" }
  /** A private window is never collected. */
  | { kind: "private" }
  /** There are no valid rules for this connection yet, so nothing is collected. */
  | { kind: "no_rules" }
  | { kind: "collected"; reason: VerdictReason }
  | { kind: "blocked"; reason: VerdictReason }
  /** The engine could not decide: nothing is collected. */
  | { kind: "error" };

/** The tab as `tabs.query` reports it. Anything but `incognito === false` counts as private. */
export interface VerdictTab {
  url?: string;
  incognito?: boolean;
}

export function currentTabVerdict(
  tab: VerdictTab | undefined,
  active: ActiveRules | null,
): TabVerdict {
  try {
    if (tab === undefined) return { kind: "unsupported" };
    if (tab.incognito !== false) return { kind: "private" };
    const page = sanitizeUrl(tab.url);
    if (page === null) return { kind: "unsupported" };
    if (active === null) return { kind: "no_rules" };
    const [visit] = probeEvents(page);
    if (visit === undefined) return { kind: "error" };
    const result = evaluate(visit, active.ruleSet, active.defaultPolicy, {
      source: "browser-extension",
      process: false,
    });
    if (result.decision === "error") return { kind: "error" };
    const decidedBy = result.trace.decidedBy;
    const reason: VerdictReason =
      decidedBy === "default_policy"
        ? { by: "default_policy" }
        : { by: "rule", ruleName: active.ruleNames.get(decidedBy) ?? "a rule" };
    return { kind: result.decision === "allow" ? "collected" : "blocked", reason };
  } catch {
    return { kind: "error" };
  }
}

/** The popup line for a verdict. `capturing` is false while paused, disconnected or not connected. */
export function describeVerdict(verdict: TabVerdict, capturing: boolean): string {
  if (!capturing) return "Nothing is collected right now.";
  switch (verdict.kind) {
    case "unsupported":
      return "This page is never collected.";
    case "private":
      return "Private windows are never collected.";
    case "no_rules":
      return "No rules loaded yet, so nothing is collected.";
    case "error":
      return "The rules could not be applied, so nothing is collected.";
    case "collected":
      return verdict.reason.by === "rule"
        ? `Collected, allowed by "${verdict.reason.ruleName}".`
        : "Collected, by your default policy.";
    case "blocked":
      return verdict.reason.by === "rule"
        ? `Not collected, blocked by "${verdict.reason.ruleName}".`
        : "Not collected, no rule allows it.";
  }
}
