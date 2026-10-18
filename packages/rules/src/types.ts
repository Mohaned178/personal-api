import type {
  ContractIssue,
  DEFAULT_POLICIES,
  EVALUATION_ERROR_REASONS,
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
  /**
   * The extension already ran this rule-set version's collect stage on the event (server only).
   * An event that no collect rule decides is then allowed, not left to the default policy, which
   * would drop an event whose own rule rewrote the field it reads (`docs/rule-format.md`, open
   * item 1). A rule that decides still decides, in the same order, and transforms and the process
   * stage still run. Only the exact value `true` turns it on.
   */
  collected?: boolean;
}

/** Why evaluation failed. The event is not collected or stored (invariant 1). */
export type EvaluationErrorReason = (typeof EVALUATION_ERROR_REASONS)[number];

export type EvaluationResult =
  | {
      decision: "allow";
      /** The event to send or store, after redact and coarsen. Valid for `parseEvent()`. */
      event: KnownEvent;
      tags: string[];
      /** Smallest `set_retention` of the matching process rules, or null for none. */
      retentionDays: number | null;
      /** A `keep_query` rule matched. See `docs/rule-format.md`, open item 2. */
      keepQuery: boolean;
      trace: RuleTrace;
    }
  // A dropped result carries no event, so a payload cannot be stored by mistake (invariant 2).
  | { decision: "drop"; trace: RuleTrace }
  | { decision: "error"; reason: EvaluationErrorReason };
