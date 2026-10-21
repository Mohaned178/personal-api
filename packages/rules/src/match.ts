import { globMatches, type RuleCondition, type RuleWhen } from "@personal-api/contracts";
import { domainMatches } from "./domain.js";
import type { SourceKind } from "./types.js";

type Data = Readonly<Record<string, unknown>>;

const DATA_PREFIX = "data.";

/** The value of `data.<key>`, or undefined when the event does not have it. Own keys only. */
function fieldValue(data: Data, field: string): unknown {
  if (!field.startsWith(DATA_PREFIX)) return undefined;
  const key = field.slice(DATA_PREFIX.length);
  return Object.hasOwn(data, key) ? data[key] : undefined;
}

function compare(op: "gt" | "lt", value: unknown, bound: string | number): boolean {
  let left: number;
  let right: number;
  if (typeof bound === "number") {
    if (typeof value !== "number") return false;
    left = value;
    right = bound;
  } else {
    if (typeof value !== "string") return false;
    left = Date.parse(value);
    right = Date.parse(bound);
  }
  if (Number.isNaN(left) || Number.isNaN(right)) return false;
  return op === "gt" ? left > right : left < right;
}

/**
 * Whether one condition holds. A condition on a field the event does not have is false for every
 * op, except `exists` (docs/rule-format.md). An op this engine does not know throws, so the
 * caller fails closed: guessing "false" there could let a `drop` rule fall through.
 */
export function conditionHolds(condition: RuleCondition, data: Data): boolean {
  const value = fieldValue(data, condition.field);
  if (condition.op === "exists") return (value !== undefined) === condition.value;
  if (value === undefined) return false;
  switch (condition.op) {
    case "eq":
      return value === condition.value;
    case "neq":
      return value !== condition.value;
    case "in":
      return condition.value.some((candidate) => candidate === value);
    case "starts_with":
      return typeof value === "string" && value.startsWith(condition.value);
    case "ends_with":
      return typeof value === "string" && value.endsWith(condition.value);
    case "contains":
      return typeof value === "string" && value.includes(condition.value);
    case "domain_matches":
      return typeof value === "string" && domainMatches(condition.value, value);
    case "matches_glob":
      return typeof value === "string" && globMatches(condition.value, value);
    case "gt":
    case "lt":
      return compare(condition.op, value, condition.value);
    default:
      throw new Error("unknown condition op");
  }
}

/** Whether a rule's `when` holds: every present part (source, type, all, any, none) must. */
export function whenHolds(
  when: RuleWhen,
  event: { type: string; data: Data },
  source: SourceKind,
): boolean {
  if (when.source !== undefined && !when.source.includes(source)) return false;
  if (when.type !== undefined && !when.type.some((pattern) => globMatches(pattern, event.type))) {
    return false;
  }
  if (when.all !== undefined && !when.all.every((c) => conditionHolds(c, event.data))) return false;
  if (when.any !== undefined && !when.any.some((c) => conditionHolds(c, event.data))) return false;
  if (when.none?.some((c) => conditionHolds(c, event.data))) return false;
  return true;
}
