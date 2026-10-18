import { PAGE_TRANSITIONS, SESSION_END_REASONS, SESSION_START_REASONS } from "./browser-events.js";
import type { EventType } from "./registry.js";

/**
 * Which fields of an event a rule condition may look at, per event type (PLAN §5). A rule that
 * names any other field is rejected on save, so a typo can never become a rule that silently
 * never matches. Field names are `data.<key>`; `source` and `type` have their own selectors.
 *
 * `specs` are checked against the event data schemas in `rule-fields.spec.ts`: a new field on an
 * event type fails the build until it is listed here or in `NOT_CONDITIONABLE_FIELDS`.
 */

export const RULE_FIELD_KINDS = ["domain", "path", "enum", "int", "timestamp"] as const;
export type RuleFieldKind = (typeof RULE_FIELD_KINDS)[number];

/** `optional` fields may be missing from an event, and are the only ones `redact` can remove. */
export type RuleFieldSpec =
  | { kind: "enum"; values: readonly string[]; optional: boolean }
  | { kind: Exclude<RuleFieldKind, "enum">; optional: boolean };

export const RULE_OPS = [
  "eq",
  "neq",
  "in",
  "starts_with",
  "ends_with",
  "contains",
  "domain_matches",
  "matches_glob",
  "gt",
  "lt",
  "exists",
] as const;
export type RuleOp = (typeof RULE_OPS)[number];

const TEXT_OPS = [
  "eq",
  "neq",
  "in",
  "starts_with",
  "ends_with",
  "contains",
  "matches_glob",
  "exists",
] as const satisfies readonly RuleOp[];

const OPS_BY_KIND: Record<RuleFieldKind, readonly RuleOp[]> = {
  domain: [...TEXT_OPS, "domain_matches"],
  path: TEXT_OPS,
  enum: ["eq", "neq", "in", "exists"],
  int: ["eq", "neq", "gt", "lt", "exists"],
  timestamp: ["gt", "lt", "exists"],
};

/** The ops a condition may use on a field of this kind. */
export function opsForKind(kind: RuleFieldKind): readonly RuleOp[] {
  return OPS_BY_KIND[kind];
}

const DOMAIN = { kind: "domain", optional: false } as const;
const OPTIONAL_DOMAIN = { kind: "domain", optional: true } as const;
const PATH = { kind: "path", optional: false } as const;

export const ruleFieldRegistry: Record<EventType, Record<string, RuleFieldSpec>> = {
  "browser.page_visited": {
    "data.domain": DOMAIN,
    "data.path": PATH,
    "data.transition": { kind: "enum", values: PAGE_TRANSITIONS, optional: true },
  },
  "browser.focus_segment": {
    "data.domain": DOMAIN,
    "data.path": PATH,
    "data.startedAt": { kind: "timestamp", optional: false },
    "data.endedAt": { kind: "timestamp", optional: false },
    "data.durationMs": { kind: "int", optional: false },
  },
  "browser.tab_opened": { "data.domain": OPTIONAL_DOMAIN },
  "browser.tab_closed": { "data.domain": OPTIONAL_DOMAIN },
  "browser.session_started": {
    "data.reason": { kind: "enum", values: SESSION_START_REASONS, optional: false },
  },
  "browser.session_ended": {
    "data.reason": { kind: "enum", values: SESSION_END_REASONS, optional: false },
  },
};

const RANDOM_TAB_REF = "A random per-session id: there is nothing meaningful to match on.";

/** Data keys that are deliberately not available to conditions, with the reason. */
export const NOT_CONDITIONABLE_FIELDS: Partial<Record<EventType, Record<string, string>>> = {
  "browser.page_visited": { tabRef: RANDOM_TAB_REF },
  "browser.tab_opened": { tabRef: RANDOM_TAB_REF },
  "browser.tab_closed": { tabRef: RANDOM_TAB_REF },
};

/** The fields conditions may use on a type. Own properties only, so `__proto__` finds nothing. */
export function getRuleFields(type: string): Record<string, RuleFieldSpec> | undefined {
  return Object.hasOwn(ruleFieldRegistry, type) ? ruleFieldRegistry[type as EventType] : undefined;
}

export function getRuleField(type: string, field: string): RuleFieldSpec | undefined {
  const fields = getRuleFields(type);
  return fields !== undefined && Object.hasOwn(fields, field) ? fields[field] : undefined;
}
