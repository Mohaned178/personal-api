import type {
  ContractIssue,
  DEFAULT_POLICIES,
  INTEGRATION_KINDS,
  KnownEvent,
  Rule,
  RuleTrace,
} from "@personal-api/contracts";

/** What happens to an event no rule decides (the integration's `default_policy`). */
export type DefaultPolicy = (typeof DEFAULT_POLICIES)[number];

/** The kind of integration that produced the event (`when.source`). */
export type SourceKind = (typeof INTEGRATION_KINDS)[number];

/**
 * A validated rule set, ready to run: only enabled rules, split by stage and sorted in
 * evaluation order. Build it with `compileRuleSet`; it is cheap to keep and reuse per version.
 */
export interface CompiledRuleSet {
  readonly version: number;
  readonly collect: readonly Rule[];
  readonly process: readonly Rule[];
}

export type CompileResult =
  | { ok: true; ruleSet: CompiledRuleSet }
  | { ok: false; issues: ContractIssue[] };

export interface EvaluateContext {
  /** The kind of integration the event came from. */
  source: SourceKind;
  /**
   * Run the `process` stage after `collect` (default true). The extension passes false: process
   * rules are server-only.
   */
  process?: boolean;
}

/** Why evaluation failed. The event is not collected or stored (invariant 1). */
export type EvaluationErrorReason =
  | "invalid_context"
  | "invalid_event"
  | "invalid_result"
  | "failed";

export type EvaluationResult =
  | {
      decision: "allow";
      /** The event to send or store, after redact and coarsen. Valid for `parseEvent()`. */
      event: KnownEvent;
      tags: string[];
      /** Smallest `set_retention` of the matching process rules, or null for none. */
      retentionDays: number | null;
      /** A `keep_query` rule matched. See `docs/rule-format.md`, open item 1. */
      keepQuery: boolean;
      trace: RuleTrace;
    }
  // A dropped result carries no event, so a payload cannot be stored by mistake (invariant 2).
  | { decision: "drop"; trace: RuleTrace }
  | { decision: "error"; reason: EvaluationErrorReason };
