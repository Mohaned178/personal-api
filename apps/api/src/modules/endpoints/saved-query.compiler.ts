import {
  type RuleCondition,
  SAVED_QUERY_LIMITS,
  type SavedQueryAggregate,
  type SavedQueryDefinition,
  type SavedQueryField,
  type SavedQueryWindow,
  savedQueryDefinitionSchema,
} from "@personal-api/contracts";
import { and, eq, inArray, not, or, type SQL, sql } from "drizzle-orm";
import { events, integrations } from "../../platform/db/schema";
import { assertUserScope, scopeCondition } from "../../platform/db/tenant-scope";
import { restrictionConditions } from "../events/events.repository";

const FOCUS_SEGMENT = "browser.focus_segment";
const DATA_PREFIX = "data.";

export interface CompileContext {
  userId: string;
  /** The time `today` and friends are relative to. From the clock, so tests can fix it. */
  now: Date;
  /** The user's IANA zone: where days and weeks begin. */
  timeZone: string;
}

/**
 * A saved query ready to run. `where` selects the events (window, source, type, conditions) and
 * does NOT include the tenant scope: the repository ANDs `user_id` on (invariant 4). An aggregate
 * has no `fields` at all, so nothing in a compiled aggregate can name a raw event column.
 */
export type CompiledSavedQuery =
  | { kind: "events"; where: SQL; fields: SavedQueryField[]; limit: number }
  | { kind: SavedQueryAggregate; where: SQL; limit: number; timeZone: string };

/** The stored definition does not parse. Fixed message: it never repeats the definition's values. */
export class InvalidSavedQueryError extends Error {
  constructor() {
    super("Saved query definition is invalid");
    this.name = "InvalidSavedQueryError";
  }
}

/**
 * Turns a definition into a parameterized condition. The definition is parsed again here, because
 * it comes out of a jsonb column: anything that does not parse throws, and a filter is never
 * skipped (a skipped filter widens the result, invariant 1). Values and JSON keys are bound
 * parameters (invariant 7); a field name selects a column or a key from a closed list and is never
 * an identifier.
 */
export function compileSavedQuery(
  definition: unknown,
  context: CompileContext,
): CompiledSavedQuery {
  assertUserScope(context.userId);
  const parsed = savedQueryDefinitionSchema.safeParse(definition);
  if (!parsed.success || context.timeZone.trim() === "") throw new InvalidSavedQueryError();
  const query = parsed.data;

  const where = and(
    windowCondition(query.window, context),
    ...whenConditions(query, context),
    // The one aggregate that is about time: only focus segments carry a duration.
    query.aggregate === "duration_by_domain" ? eq(events.type, FOCUS_SEGMENT) : undefined,
  ) as SQL;
  const limit = query.limit ?? SAVED_QUERY_LIMITS.rowsDefault;

  if (query.aggregate !== undefined) {
    return { kind: query.aggregate, where, limit, timeZone: context.timeZone };
  }
  if (query.fields === undefined) throw new InvalidSavedQueryError();
  return { kind: "events", where, fields: [...query.fields], limit };
}

/**
 * Bounds are computed by Postgres from a bound `now` and zone, so days are local and daylight
 * saving is right: `today` is [local midnight, next local midnight), `this_week` starts on Monday,
 * and `last_n_days` is n calendar days ending at the end of today.
 */
function windowCondition(window: SavedQueryWindow, { now, timeZone }: CompileContext): SQL {
  const localNow = sql`(${now.toISOString()}::timestamptz at time zone ${timeZone}::text)`;
  const startOf = (unit: "day" | "week", back: SQL = sql`interval '0'`) =>
    sql`((date_trunc(${unit}::text, ${localNow}) - ${back}) at time zone ${timeZone}::text)`;
  const endOf = (unit: "day" | "week", step: SQL) =>
    sql`((date_trunc(${unit}::text, ${localNow}) + ${step}) at time zone ${timeZone}::text)`;

  let from: SQL;
  let to: SQL;
  switch (window.kind) {
    case "today":
      from = startOf("day");
      to = endOf("day", sql`interval '1 day'`);
      break;
    case "this_week":
      from = startOf("week");
      to = endOf("week", sql`interval '1 week'`);
      break;
    case "last_n_days":
      from = startOf("day", sql`(${window.days - 1}::int * interval '1 day')`);
      to = endOf("day", sql`interval '1 day'`);
      break;
    default:
      return assertNever(window);
  }
  return sql`(${events.occurredAt} >= ${from} and ${events.occurredAt} < ${to})`;
}

function whenConditions(
  query: SavedQueryDefinition,
  context: CompileContext,
): Array<SQL | undefined> {
  const { source, type, all, any, none } = query.when;
  return [
    source === undefined ? undefined : sourceCondition(source, context.userId),
    type === undefined ? undefined : and(...restrictionConditions(undefined, type)),
    all === undefined ? undefined : and(...all.map(conditionSql)),
    any === undefined ? undefined : or(...any.map(conditionSql)),
    // Every condition is already false-or-true (see `conditionSql`), so `not` is exact: a missing
    // field satisfies a `none`, as in the engine.
    none === undefined ? undefined : not(or(...none.map(conditionSql)) as SQL),
  ];
}

/** `source` is the integration kind (as in rules). The subquery is user-scoped like every other. */
function sourceCondition(kinds: readonly string[], userId: string): SQL {
  const owned = scopeCondition(integrations, userId, inArray(integrations.kind, [...kinds]));
  return sql`${events.integrationId} in (select ${integrations.id} from ${integrations} where ${owned})`;
}

/** The value of `data.<key>`. The key is a bound parameter. */
function jsonField(field: string): SQL {
  if (!field.startsWith(DATA_PREFIX)) throw new InvalidSavedQueryError();
  return sql`(${events.data} -> ${field.slice(DATA_PREFIX.length)}::text)`;
}

/** The field as text, or NULL when it is missing or not a string, so a type mismatch never matches. */
function textField(field: string): SQL {
  const json = jsonField(field);
  return sql`(case when jsonb_typeof(${json}) = 'string' then ${json} #>> '{}' end)`;
}

function numberField(field: string): SQL {
  const json = jsonField(field);
  return sql`(case when jsonb_typeof(${json}) = 'number' then (${json})::numeric end)`;
}

function jsonValue(value: string | number): SQL {
  return typeof value === "number"
    ? sql`to_jsonb(${value}::numeric)`
    : sql`to_jsonb(${value}::text)`;
}

/** A glob (`*` only) as a LIKE pattern: `%`, `_` and `\` in the text stay literal (PG's default escape is `\`). */
function globToLikePattern(glob: string): string {
  return glob.replace(/[\\%_]/g, "\\$&").replaceAll("*", "%");
}

/**
 * One condition, with the engine's semantics (`packages/rules/src/match.ts`). SQL's NULL stands
 * for a missing field or a type mismatch, and the engine says that is false for every op except
 * `exists: false`, so the result is coalesced to false: otherwise a `none` on a missing field
 * would be NULL and drop the row instead of satisfying it.
 */
function conditionSql(condition: RuleCondition): SQL {
  const field = condition.field;
  let holds: SQL;
  switch (condition.op) {
    case "exists":
      holds = condition.value
        ? sql`jsonb_exists(${events.data}, ${field.slice(DATA_PREFIX.length)}::text)`
        : sql`not jsonb_exists(${events.data}, ${field.slice(DATA_PREFIX.length)}::text)`;
      break;
    case "eq":
      holds = sql`${jsonField(field)} = ${jsonValue(condition.value)}`;
      break;
    case "neq":
      holds = sql`${jsonField(field)} <> ${jsonValue(condition.value)}`;
      break;
    case "in":
      holds = or(...condition.value.map((v) => sql`${jsonField(field)} = ${jsonValue(v)}`)) as SQL;
      break;
    case "starts_with":
      holds = sql`starts_with(${textField(field)}, ${condition.value}::text)`;
      break;
    case "ends_with":
      holds = endsWith(field, condition.value);
      break;
    case "contains":
      holds = sql`strpos(${textField(field)}, ${condition.value}::text) > 0`;
      break;
    case "domain_matches":
      // `*.example.com` is any subdomain and never the apex; a bare domain matches exactly.
      holds = condition.value.startsWith("*.")
        ? endsWith(field, condition.value.slice(1))
        : sql`${textField(field)} = ${condition.value}::text`;
      break;
    case "matches_glob":
      holds = sql`${textField(field)} like ${globToLikePattern(condition.value)}::text`;
      break;
    case "gt":
    case "lt": {
      const operator = condition.op === "gt" ? sql`>` : sql`<`;
      holds =
        typeof condition.value === "number"
          ? sql`${numberField(field)} ${operator} ${condition.value}::numeric`
          : sql`${textField(field)}::timestamptz ${operator} ${condition.value}::timestamptz`;
      break;
    }
    default:
      return assertNever(condition);
  }
  return sql`coalesce(${holds}, false)`;
}

function endsWith(field: string, suffix: string): SQL {
  return sql`right(${textField(field)}, char_length(${suffix}::text)) = ${suffix}::text`;
}

/** An op, aggregate or window this build does not know is an error, never "false" or "everything". */
function assertNever(value: never): never {
  void value;
  throw new InvalidSavedQueryError();
}
