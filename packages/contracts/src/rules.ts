import { z } from "zod";
import { safeMessage } from "./errors.js";
import { INTEGRATION_KINDS } from "./integrations.js";
import { domainSchema, pathSchema, utcDateTimeSchema } from "./primitives.js";
import { EVENT_TYPES } from "./registry.js";
import { getRuleField, opsForKind, type RuleFieldSpec, type RuleOp } from "./rule-fields.js";
import { GLOB_MAX_WILDCARDS, globMatches } from "./rule-glob.js";

/**
 * The rule format (PLAN §5, `docs/rule-format.md`). A rule says which events it applies to
 * (`when`) and what to do with them (`then`). The same document is edited in the dashboard,
 * stored in `rules.definition`, sent to the extension and run by the engine on both sides.
 *
 * Everything is strict: an unknown key is an error. There is no regex and no code (invariant 8).
 * Issue messages are fixed strings (invariant 6): they never contain a rule's values, which are
 * domains and paths.
 */

export const RULE_STAGES = ["collect", "process"] as const;
export type RuleStage = (typeof RULE_STAGES)[number];

export const RULE_LIMITS = {
  nameMax: 100,
  /** Lower numbers are evaluated first. */
  priorityMax: 1000,
  actionsMax: 10,
  conditionsMax: 20,
  typesMax: 20,
  /** Longest `when.type` pattern (the same as the envelope's `type`). */
  globMax: 128,
  /** Longest value in a condition, `matches_glob` patterns included. */
  valueMax: 256,
  inMax: 50,
  tagMax: 32,
  retentionDaysMax: 3650,
  coarsenSegmentsMax: 10,
} as const;

/** Action names kept for later versions. A rule that uses one is rejected, never ignored. */
export const RESERVED_ACTIONS = ["forward"] as const;

/** Every action a rule can use, in the order the docs list them. A test keeps it in step with `ruleActionSchema`. */
export const RULE_ACTION_NAMES = [
  "allow",
  "drop",
  "keep_query",
  "redact",
  "coarsen",
  "tag",
  "set_retention",
] as const;

/** The actions each stage accepts. Collect rules decide and reshape; process rules only label. */
export const RULE_ACTIONS_BY_STAGE = {
  collect: ["allow", "drop", "redact", "coarsen", "keep_query"],
  process: ["tag", "set_retention"],
} as const satisfies Record<RuleStage, readonly string[]>;

const UNKNOWN_FIELD = safeMessage("Unknown field for the selected event types");
const OP_NOT_ALLOWED = safeMessage("Operator is not allowed for this field");
const VALUE_NOT_ALLOWED = safeMessage("Value does not fit this field and operator");
const NO_MATCHING_TYPE = safeMessage("Pattern matches no known event type");
const ACTION_NOT_IN_STAGE = safeMessage("Action is not allowed in this stage");
const SECOND_DECISION = safeMessage("Only one action may decide the outcome");
const DUPLICATE_ACTION = safeMessage("Duplicate action");
const REQUIRED_FIELD = safeMessage(
  "Field is required on a selected event type, so it cannot be redacted",
);
const NO_PATH = safeMessage("None of the selected event types has a path to coarsen");
const DUPLICATE_ENTRIES = safeMessage("Duplicate entries");
const TEXT_FORMAT = safeMessage("Expected non-empty text without control characters");
const GLOB_FORMAT = safeMessage("Too many wildcards");
const DOMAIN_PATTERN_FORMAT = safeMessage("Expected a domain, or *. followed by a domain");
const TYPE_PATTERN_FORMAT = safeMessage("Expected lowercase letters, digits, _ . and *");
const FIELD_FORMAT = safeMessage("Expected a field name such as data.domain");
const TAG_FORMAT = safeMessage("Expected a lowercase tag of letters, digits and _ . : -");

/** Non-empty, no control characters, no lone surrogates (the same hygiene as `pathSchema`). */
const textValueSchema = z
  .string()
  .max(RULE_LIMITS.valueMax)
  .regex(/^[^\p{Cc}\p{Cs}]+$/u, TEXT_FORMAT);

const globValueSchema = textValueSchema.refine((v) => countWildcards(v) <= GLOB_MAX_WILDCARDS, {
  message: GLOB_FORMAT,
});

/** `example.com` (exact) or `*.example.com` (any subdomain, not the apex). */
const domainPatternSchema = z
  .string()
  .max(RULE_LIMITS.valueMax)
  .refine((v) => domainSchema.safeParse(v.startsWith("*.") ? v.slice(2) : v).success, {
    message: DOMAIN_PATTERN_FORMAT,
  });

const scalarSchema = z.union([textValueSchema, z.number()]);

/** `data.<key>`. Whether the key exists for the selected types is checked per rule. */
const fieldSchema = z
  .string()
  .max(80)
  .regex(/^data\.[A-Za-z][A-Za-z0-9]{0,63}$/, FIELD_FORMAT);

function countWildcards(value: string): number {
  let count = 0;
  for (const char of value) if (char === "*") count++;
  return count;
}

function condition<const Op extends RuleOp, V extends z.ZodType>(op: Op, value: V) {
  return z.strictObject({ field: fieldSchema, op: z.literal(op), value });
}

export const ruleConditionSchema = z.discriminatedUnion("op", [
  condition("eq", scalarSchema),
  condition("neq", scalarSchema),
  condition("in", z.array(scalarSchema).min(1).max(RULE_LIMITS.inMax)),
  condition("starts_with", textValueSchema),
  condition("ends_with", textValueSchema),
  condition("contains", textValueSchema),
  condition("domain_matches", domainPatternSchema),
  condition("matches_glob", globValueSchema),
  condition("gt", z.union([z.number(), utcDateTimeSchema])),
  condition("lt", z.union([z.number(), utcDateTimeSchema])),
  condition("exists", z.boolean()),
]);
export type RuleCondition = z.output<typeof ruleConditionSchema>;

export const ruleActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("allow") }),
  z.strictObject({ action: z.literal("drop") }),
  z.strictObject({ action: z.literal("keep_query") }),
  z.strictObject({ action: z.literal("redact"), field: fieldSchema }),
  z.strictObject({
    action: z.literal("coarsen"),
    /** Keep the first N path segments. 0 leaves `/`. */
    segments: z.int().min(0).max(RULE_LIMITS.coarsenSegmentsMax),
  }),
  z.strictObject({
    action: z.literal("tag"),
    tag: z
      .string()
      .max(RULE_LIMITS.tagMax)
      .regex(/^[a-z0-9][a-z0-9_.:-]*$/, TAG_FORMAT),
  }),
  z.strictObject({
    action: z.literal("set_retention"),
    days: z.int().min(1).max(RULE_LIMITS.retentionDaysMax),
  }),
]);
export type RuleAction = z.output<typeof ruleActionSchema>;

/** An event type or a `*` glob over types. */
export const typePatternSchema = z
  .string()
  .min(1)
  .max(RULE_LIMITS.globMax)
  .regex(/^[a-z0-9_.*]+$/, TYPE_PATTERN_FORMAT)
  .refine((v) => countWildcards(v) <= GLOB_MAX_WILDCARDS, { message: GLOB_FORMAT });

const conditionListSchema = z.array(ruleConditionSchema).min(1).max(RULE_LIMITS.conditionsMax);

/**
 * Which events a rule applies to. Every part that is present must hold (AND). `source` and `type`
 * match any of their entries; `all` needs every condition, `any` at least one, `none` zero. An
 * empty `when` applies to every event.
 */
export const ruleWhenSchema = z.strictObject({
  source: z
    .array(z.enum(INTEGRATION_KINDS))
    .min(1)
    .max(INTEGRATION_KINDS.length)
    .refine((list) => new Set(list).size === list.length, { message: DUPLICATE_ENTRIES })
    .optional(),
  type: z.array(typePatternSchema).min(1).max(RULE_LIMITS.typesMax).optional(),
  all: conditionListSchema.optional(),
  any: conditionListSchema.optional(),
  none: conditionListSchema.optional(),
});
export type RuleWhen = z.output<typeof ruleWhenSchema>;

const ruleBaseShape = {
  name: z.string().trim().min(1).max(RULE_LIMITS.nameMax),
  enabled: z.boolean(),
  priority: z.int().min(0).max(RULE_LIMITS.priorityMax),
  stage: z.enum(RULE_STAGES),
  when: ruleWhenSchema,
  then: z.array(ruleActionSchema).min(1).max(RULE_LIMITS.actionsMax),
};

type RuleBase = z.output<z.ZodObject<typeof ruleBaseShape>>;

/** The registered event types a rule's `when.type` can reach. No `type` means all of them. */
export function selectedEventTypes(patterns: readonly string[] | undefined): string[] {
  return [...EVENT_TYPES].filter(
    (type) => patterns === undefined || patterns.some((pattern) => globMatches(pattern, type)),
  );
}

function specsFor(types: readonly string[], field: string): RuleFieldSpec[] {
  return types.flatMap((type) => getRuleField(type, field) ?? []);
}

function scalarFits(spec: RuleFieldSpec, value: unknown): boolean {
  switch (spec.kind) {
    case "domain":
      return typeof value === "string" && domainSchema.safeParse(value).success;
    case "path":
      return typeof value === "string" && pathSchema.safeParse(value).success;
    case "enum":
      return typeof value === "string" && spec.values.includes(value);
    case "int":
      return typeof value === "number" && Number.isInteger(value);
    case "timestamp":
      return false;
  }
}

function valueFits(spec: RuleFieldSpec, cond: RuleCondition): boolean {
  switch (cond.op) {
    case "eq":
    case "neq":
      return scalarFits(spec, cond.value);
    case "in":
      return cond.value.every((value) => scalarFits(spec, value));
    case "gt":
    case "lt":
      return spec.kind === "int" ? typeof cond.value === "number" : typeof cond.value === "string";
    default:
      // Text ops and `exists`: the shape was checked by the condition schema, and the op list
      // per kind has already ruled out the wrong fields.
      return true;
  }
}

/**
 * Checks a `when` against the event types it selects: every `type` pattern must match a type, and
 * every condition must name a field, op and value that fit. Issue paths start at `base`. Returns
 * the selected types.
 */
export function validateRuleWhen(
  when: RuleWhen,
  ctx: z.RefinementCtx,
  base: (string | number)[],
): string[] {
  const addIssue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });
  const types = selectedEventTypes(when.type);

  when.type?.forEach((pattern, index) => {
    if (![...EVENT_TYPES].some((type) => globMatches(pattern, type))) {
      addIssue([...base, "type", index], NO_MATCHING_TYPE);
    }
  });

  // A field must exist on at least one selected type, the op must suit every kind it has, and the
  // value must fit at least one of them (`reason eq idle` is fine for `browser.session_*`): on the others the condition simply does
  // not match, which is how `type: ["browser.*"]` can mention `data.path` (PLAN §5 example).
  for (const group of ["all", "any", "none"] as const) {
    when[group]?.forEach((cond, index) => {
      const path = [...base, group, index];
      const specs = specsFor(types, cond.field);
      if (specs.length === 0) {
        addIssue([...path, "field"], UNKNOWN_FIELD);
      } else if (specs.some((spec) => !opsForKind(spec.kind).includes(cond.op))) {
        addIssue([...path, "op"], OP_NOT_ALLOWED);
      } else if (!specs.some((spec) => valueFits(spec, cond))) {
        addIssue([...path, "value"], VALUE_NOT_ALLOWED);
      }
    });
  }
  return types;
}

function validateRule(rule: RuleBase, ctx: z.RefinementCtx): void {
  const addIssue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });
  const types = validateRuleWhen(rule.when, ctx, ["when"]);

  const allowed: readonly string[] = RULE_ACTIONS_BY_STAGE[rule.stage];
  const seen = new Set<string>();
  let decisions = 0;
  rule.then.forEach((action, index) => {
    if (!allowed.includes(action.action)) {
      addIssue(["then", index, "action"], ACTION_NOT_IN_STAGE);
      return;
    }
    const key =
      action.action === "redact"
        ? `redact:${action.field}`
        : action.action === "tag"
          ? `tag:${action.tag}`
          : action.action;
    if (seen.has(key)) addIssue(["then", index], DUPLICATE_ACTION);
    seen.add(key);

    if (action.action === "allow" || action.action === "drop") {
      decisions++;
      if (decisions > 1) addIssue(["then", index, "action"], SECOND_DECISION);
    } else if (action.action === "redact") {
      const specs = specsFor(types, action.field);
      if (specs.length === 0) addIssue(["then", index, "field"], UNKNOWN_FIELD);
      else if (specs.some((spec) => !spec.optional))
        addIssue(["then", index, "field"], REQUIRED_FIELD);
    } else if (action.action === "coarsen" && specsFor(types, "data.path").length === 0) {
      addIssue(["then", index, "action"], NO_PATH);
    }
  });
}

/**
 * A rule as a user writes it: what `POST /v1/rules` accepts and the JSON editor shows. It has no
 * `id` and no `userId`; both are set by the server (invariant 4).
 */
export const ruleDefinitionSchema = z.strictObject(ruleBaseShape).superRefine(validateRule);
export type RuleDefinition = z.output<typeof ruleDefinitionSchema>;

/**
 * Actions the engine still understands but the save path rejects in v1. `keep_query` is reserved
 * for v1.1: URLs always lose their query string and fragment (invariant 3). Rules that already
 * hold one still load and run, so the engine never fails closed on stored data.
 */
export const SAVE_RESERVED_ACTIONS = ["keep_query"] as const;

const RESERVED_FOR_LATER = safeMessage("This action is reserved for a later version");

/**
 * What `POST`/`PUT /v1/rules`, the dry run and the dashboard editor accept: a definition without
 * the actions in `SAVE_RESERVED_ACTIONS`. Use `ruleDefinitionSchema` for anything already stored.
 */
export const ruleSaveSchema = ruleDefinitionSchema.superRefine((rule, ctx) => {
  rule.then.forEach((action, index) => {
    if ((SAVE_RESERVED_ACTIONS as readonly string[]).includes(action.action)) {
      ctx.addIssue({
        code: "custom",
        path: ["then", index, "action"],
        message: RESERVED_FOR_LATER,
      });
    }
  });
});

/** A stored rule: the definition plus the id the server gave it. What the engine runs. */
export const ruleSchema = z
  .strictObject({ id: z.uuid(), ...ruleBaseShape })
  .superRefine(validateRule);
export type Rule = z.output<typeof ruleSchema>;

const DUPLICATE_RULE_ID = safeMessage("Duplicate rule id");

/**
 * A user's rules at one version: what the engine runs and what the extension fetches (M4-06).
 * The number of rules per user is capped by the rules API (M4-04), not here.
 */
export const ruleSetSchema = z
  .strictObject({ version: z.int().min(0), rules: z.array(ruleSchema) })
  .superRefine((ruleSet, ctx) => {
    const seen = new Set<string>();
    ruleSet.rules.forEach((rule, index) => {
      if (seen.has(rule.id)) {
        ctx.addIssue({ code: "custom", path: ["rules", index, "id"], message: DUPLICATE_RULE_ID });
      }
      seen.add(rule.id);
    });
  });
export type RuleSet = z.output<typeof ruleSetSchema>;
