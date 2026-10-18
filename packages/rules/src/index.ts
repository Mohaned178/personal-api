/**
 * @personal-api/rules: the pure rule engine (PLAN §3, principle 2). The extension, the API and
 * the "test this rule" preview all call it, so they give identical answers. No Node, DOM or I/O.
 */
export { canTrustCollected } from "./collected-trust.js";
export { compileRuleSet } from "./compile.js";
export { evaluate } from "./evaluate.js";
export type {
  CompiledRuleSet,
  CompileResult,
  DefaultPolicy,
  EvaluateContext,
  EvaluationErrorReason,
  EvaluationResult,
  SourceKind,
} from "./types.js";
