import { z } from "zod";
import { safeMessage } from "./errors.js";
import { ruleFieldRegistry } from "./rule-fields.js";
import { ruleWhenSchema, validateRuleWhen } from "./rules.js";

/**
 * The saved-query format (PLAN §6, M5-04): what a user-defined endpoint (`/v1/me/:slug`) runs.
 * A query selects events with the same `when` as a rule (source, type, `all`/`any`/`none`), inside
 * a relative time window, and returns EITHER a projection of raw events (`fields`) OR an
 * aggregate. Never both: an aggregate-only endpoint can never return raw events.
 *
 * Everything is strict, and there is no regex and no code (invariant 8). Issue messages are fixed
 * strings (invariant 6): they never contain the submitted values, which are domains and paths.
 */

export const SAVED_QUERY_LIMITS = {
  /** Hard row limit (PLAN §6). Applies to aggregates too. */
  rowsMax: 1000,
  /** Used when the definition has no `limit`. */
  rowsDefault: 100,
  /** Same maximum as the activity aggregates. */
  lastDaysMax: 90,
} as const;

/** Hard statement timeout of every saved query (PLAN §6). */
export const SAVED_QUERY_TIMEOUT_MS = 2000;

/** Code of the 504 when a saved query exceeds `SAVED_QUERY_TIMEOUT_MS`. */
export const SAVED_QUERY_TIMEOUT_CODE = "saved_query.timeout";

export const SAVED_QUERY_AGGREGATES = [
  "count_by_day",
  "count_by_domain",
  "duration_by_domain",
] as const;
export type SavedQueryAggregate = (typeof SAVED_QUERY_AGGREGATES)[number];

function dataFieldNames(): string[] {
  const names = new Set<string>();
  for (const fields of Object.values(ruleFieldRegistry))
    for (const name of Object.keys(fields)) names.add(name);
  return [...names];
}

/**
 * Fields a projection may return: `type`, `occurredAt`, and the `data.*` fields conditions can
 * already use. Not the id, tags, trace, `tabRef`, receive time or integration. A closed list, so a
 * field name from a definition is never a SQL identifier.
 */
export const SAVED_QUERY_FIELDS = ["type", "occurredAt", ...dataFieldNames()] as const;
export type SavedQueryField = (typeof SAVED_QUERY_FIELDS)[number];

/** The key a field has in a result row: `data.domain` is `domain`. A test pins that none collide. */
export function savedQueryFieldKey(field: SavedQueryField): string {
  return field.startsWith("data.") ? field.slice("data.".length) : field;
}

const FIELD_NOT_ON_TYPES = safeMessage("Field is not available on the selected event types");
const DUPLICATE_FIELDS = safeMessage("Duplicate fields");
const FIELDS_OR_AGGREGATE = safeMessage("Expected exactly one of fields and aggregate");
const AGGREGATE_NEEDS_TYPE = safeMessage("The selected event types cannot produce this aggregate");

export const savedQueryWindowSchema = z.discriminatedUnion("kind", [
  /** From local midnight to the next, in the user's time zone. */
  z.strictObject({ kind: z.literal("today") }),
  /** From Monday 00:00 local to the next Monday. */
  z.strictObject({ kind: z.literal("this_week") }),
  /** `days` calendar days ending at the end of today (local). */
  z.strictObject({
    kind: z.literal("last_n_days"),
    days: z.int().min(1).max(SAVED_QUERY_LIMITS.lastDaysMax),
  }),
]);
export type SavedQueryWindow = z.output<typeof savedQueryWindowSchema>;

const fieldsSchema = z
  .array(z.enum(SAVED_QUERY_FIELDS))
  .min(1)
  .max(SAVED_QUERY_FIELDS.length)
  .refine((fields) => new Set(fields).size === fields.length, { message: DUPLICATE_FIELDS });

/** Whether an event type has a `data.<key>` field, per the rule field registry. */
function typeHasDataField(type: string, field: string): boolean {
  const fields = ruleFieldRegistry[type as keyof typeof ruleFieldRegistry];
  return fields !== undefined && Object.hasOwn(fields, field);
}

export const savedQueryDefinitionSchema = z
  .strictObject({
    when: ruleWhenSchema,
    window: savedQueryWindowSchema,
    fields: fieldsSchema.optional(),
    aggregate: z.enum(SAVED_QUERY_AGGREGATES).optional(),
    limit: z.int().min(1).max(SAVED_QUERY_LIMITS.rowsMax).optional(),
  })
  .superRefine((query, ctx) => {
    const types = validateRuleWhen(query.when, ctx, ["when"]);

    if ((query.fields === undefined) === (query.aggregate === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: query.aggregate === undefined ? ["fields"] : ["aggregate"],
        message: FIELDS_OR_AGGREGATE,
      });
      return;
    }

    query.fields?.forEach((field, index) => {
      const known =
        field === "type" || field === "occurredAt" || types.some((t) => typeHasDataField(t, field));
      if (!known)
        ctx.addIssue({ code: "custom", path: ["fields", index], message: FIELD_NOT_ON_TYPES });
    });

    if (query.aggregate === "duration_by_domain" && !types.includes("browser.focus_segment")) {
      ctx.addIssue({ code: "custom", path: ["aggregate"], message: AGGREGATE_NEEDS_TYPE });
    }
    if (
      query.aggregate === "count_by_domain" &&
      !types.some((t) => typeHasDataField(t, "data.domain"))
    ) {
      ctx.addIssue({ code: "custom", path: ["aggregate"], message: AGGREGATE_NEEDS_TYPE });
    }
  });
export type SavedQueryDefinition = z.output<typeof savedQueryDefinitionSchema>;

/** A projected value is a string, a number, or null where the event type lacks the field. */
const cellSchema = z.union([z.string(), z.number(), z.null()]);

export const savedQueryResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("events"),
    rows: z.array(z.record(z.string(), cellSchema)),
    truncated: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("count_by_day"),
    rows: z.array(
      z.strictObject({
        /** `YYYY-MM-DD` in the user's time zone. */
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        count: z.number().int().min(0),
      }),
    ),
    truncated: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("count_by_domain"),
    rows: z.array(z.strictObject({ domain: z.string(), count: z.number().int().min(0) })),
    truncated: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("duration_by_domain"),
    rows: z.array(z.strictObject({ domain: z.string(), activeMs: z.number().int().min(0) })),
    truncated: z.boolean(),
  }),
]);
export type SavedQueryResult = z.output<typeof savedQueryResultSchema>;

/** Code of the 409 when a stored definition no longer parses: nothing is guessed or skipped (invariant 1). */
export const SAVED_QUERY_INVALID_CODE = "saved_query.definition_invalid";
