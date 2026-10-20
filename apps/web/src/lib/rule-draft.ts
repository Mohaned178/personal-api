import {
  type ContractIssue,
  getRuleFields,
  opsForKind,
  type RULE_ACTIONS_BY_STAGE,
  type RuleDefinition,
  type RuleFieldKind,
  type RuleOp,
  type RuleStage,
  ruleFieldRegistry,
  ruleSaveSchema,
  toContractIssues,
} from "@personal-api/contracts";

/**
 * The rule form's state and its two-way mapping to the rule document. The form keeps every value
 * as text; `draftToRule` turns it into the document, and the contracts' `ruleSaveSchema`
 * (the schema the API and the engine use) is the only judge of whether that document is valid.
 * Pure, with no I/O.
 */

export const CONDITION_GROUPS = ["all", "any", "none"] as const;
export type ConditionGroup = (typeof CONDITION_GROUPS)[number];

export type ActionName =
  | (typeof RULE_ACTIONS_BY_STAGE)[RuleStage][number]
  | "tag"
  | "set_retention";

export interface ConditionDraft {
  field: string;
  op: RuleOp;
  value: string;
}

export interface ActionDraft {
  action: ActionName;
  /** `redact`: a field name, `coarsen`: segments, `tag`: the tag, `set_retention`: days. */
  param: string;
}

export interface RuleDraft {
  name: string;
  enabled: boolean;
  priority: string;
  stage: RuleStage;
  sources: string[];
  /** One pattern per line or comma-separated. */
  types: string;
  conditions: Record<ConditionGroup, ConditionDraft[]>;
  then: ActionDraft[];
}

/** Every field name a condition can use, across all event types, with the kind of its first spec. */
export const CONDITION_FIELDS: readonly { field: string; kind: RuleFieldKind }[] = (() => {
  const seen = new Map<string, RuleFieldKind>();
  for (const specs of Object.values(ruleFieldRegistry)) {
    for (const [field, spec] of Object.entries(specs))
      if (!seen.has(field)) seen.set(field, spec.kind);
  }
  return [...seen].map(([field, kind]) => ({ field, kind }));
})();

export function fieldKind(field: string): RuleFieldKind | undefined {
  return CONDITION_FIELDS.find((f) => f.field === field)?.kind;
}

/** The ops a condition on this field may use (every op for an unknown field, so nothing is hidden). */
export function opsForField(field: string): readonly RuleOp[] {
  const kind = fieldKind(field);
  return kind ? opsForKind(kind) : opsForKind("domain");
}

/** The fields a `redact` action can name: optional on at least one event type. */
export const REDACTABLE_FIELDS: readonly string[] = [
  ...new Set(
    Object.keys(ruleFieldRegistry).flatMap((type) =>
      Object.entries(getRuleFields(type) ?? {}).flatMap(([field, spec]) =>
        spec.optional ? [field] : [],
      ),
    ),
  ),
];

export function emptyDraft(): RuleDraft {
  return {
    name: "",
    enabled: true,
    priority: "100",
    stage: "collect",
    sources: [],
    types: "",
    conditions: { all: [], any: [], none: [] },
    then: [{ action: "allow", param: "" }],
  };
}

export function newCondition(): ConditionDraft {
  return { field: "data.domain", op: "domain_matches", value: "" };
}

const NEEDS_PARAM: ReadonlySet<string> = new Set(["redact", "coarsen", "tag", "set_retention"]);
export const actionNeedsParam = (action: ActionName): boolean => NEEDS_PARAM.has(action);

function splitList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

const asNumber = (text: string): number | string => {
  const trimmed = text.trim();
  return trimmed !== "" && Number.isFinite(Number(trimmed)) ? Number(trimmed) : text;
};

function conditionValue(c: ConditionDraft): unknown {
  const kind = fieldKind(c.field);
  const numeric = kind === "int";
  switch (c.op) {
    case "exists":
      return c.value !== "false";
    case "in":
      return splitList(c.value).map((v) => (numeric ? asNumber(v) : v));
    case "eq":
    case "neq":
    case "gt":
    case "lt":
      return numeric ? asNumber(c.value) : c.value;
    default:
      return c.value;
  }
}

function actionDocument(a: ActionDraft): Record<string, unknown> {
  switch (a.action) {
    case "redact":
      return { action: "redact", field: a.param };
    case "coarsen":
      return { action: "coarsen", segments: asNumber(a.param) };
    case "tag":
      return { action: "tag", tag: a.param };
    case "set_retention":
      return { action: "set_retention", days: asNumber(a.param) };
    default:
      return { action: a.action };
  }
}

/** The rule document the form describes. Not validated: pass it to `validateRule`. */
export function draftToRule(draft: RuleDraft): Record<string, unknown> {
  const when: Record<string, unknown> = {};
  if (draft.sources.length > 0) when.source = draft.sources;
  const types = splitList(draft.types);
  if (types.length > 0) when.type = types;
  for (const group of CONDITION_GROUPS) {
    const list = draft.conditions[group];
    if (list.length > 0) {
      when[group] = list.map((c) => ({ field: c.field, op: c.op, value: conditionValue(c) }));
    }
  }
  return {
    name: draft.name,
    enabled: draft.enabled,
    priority: asNumber(draft.priority),
    stage: draft.stage,
    when,
    then: draft.then.map(actionDocument),
  };
}

const valueText = (value: unknown): string =>
  Array.isArray(value) ? value.join(", ") : String(value);

function actionDraft(a: RuleDefinition["then"][number]): ActionDraft {
  switch (a.action) {
    case "redact":
      return { action: "redact", param: a.field };
    case "coarsen":
      return { action: "coarsen", param: String(a.segments) };
    case "tag":
      return { action: "tag", param: a.tag };
    case "set_retention":
      return { action: "set_retention", param: String(a.days) };
    default:
      return { action: a.action, param: "" };
  }
}

/** Loads a valid rule into the form. */
export function ruleToDraft(rule: RuleDefinition): RuleDraft {
  const draft = emptyDraft();
  draft.name = rule.name;
  draft.enabled = rule.enabled;
  draft.priority = String(rule.priority);
  draft.stage = rule.stage;
  draft.sources = [...(rule.when.source ?? [])];
  draft.types = (rule.when.type ?? []).join(", ");
  for (const group of CONDITION_GROUPS) {
    draft.conditions[group] = (rule.when[group] ?? []).map((c) => ({
      field: c.field,
      op: c.op,
      value: valueText(c.value),
    }));
  }
  draft.then = rule.then.map(actionDraft);
  return draft;
}

export type RuleValidation =
  | { ok: true; rule: RuleDefinition }
  | { ok: false; issues: ContractIssue[] };

/** Checks a rule document with the shared schema. Messages are fixed strings, never the input. */
export function validateRule(document: unknown): RuleValidation {
  const parsed = ruleSaveSchema.safeParse(document);
  return parsed.success
    ? { ok: true, rule: parsed.data }
    : { ok: false, issues: toContractIssues(parsed.error.issues) };
}

export const formatIssuePath = (path: readonly (string | number)[]): string =>
  path.length === 0 ? "rule" : path.join(".");
