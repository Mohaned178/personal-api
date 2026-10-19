/**
 * M5-06 injection attempts against the saved-query compiler (no database: the compiled condition is
 * rendered with drizzle's PgDialect and read as SQL text plus parameters). Field names are a closed
 * list and values are bound parameters (invariants 7 and 8), so a hostile string must never show up
 * in the SQL text, and a hostile field, key or number must be refused rather than compiled.
 */
import {
  SAVED_QUERY_LIMITS,
  type SavedQueryDefinition,
  savedQueryDefinitionSchema,
} from "@personal-api/contracts";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { compileSavedQuery, InvalidSavedQueryError } from "./saved-query.compiler";

const TOKEN = "PAYLOAD7f3a";
const NOW = new Date("2026-10-14T12:00:00.000Z");
const context = { userId: "user-1", now: NOW, timeZone: "UTC" };
const dialect = new PgDialect();

const HOSTILE_VALUES = [
  `x'); drop table events; --${TOKEN}`,
  `' or '1'='1${TOKEN}`,
  `\\' ${TOKEN}`,
  `$$ ${TOKEN} $$`,
  `"; select pg_sleep(10); --${TOKEN}`,
  `%${TOKEN}_`,
  `${TOKEN}'::text || (select email from "user" limit 1) || '`,
];

const TEXT_OPS = ["starts_with", "ends_with", "contains", "matches_glob"] as const;

const base = {
  when: { type: ["browser.page_visited"] },
  window: { kind: "today" },
  fields: ["data.domain"],
};

function render(definition: unknown, ctx = context) {
  const compiled = compileSavedQuery(definition, ctx);
  return dialect.sqlToQuery(compiled.where);
}

function refused(definition: unknown): InvalidSavedQueryError {
  try {
    compileSavedQuery(definition, context);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidSavedQueryError);
    return error as InvalidSavedQueryError;
  }
  throw new Error("expected the definition to be refused");
}

describe("hostile values are bound parameters, never SQL text", () => {
  for (const op of TEXT_OPS) {
    for (const field of ["data.domain", "data.path"]) {
      it(`${op} on ${field}`, () => {
        for (const value of HOSTILE_VALUES) {
          const definition = { ...base, when: { all: [{ field, op, value }] } };
          const { sql, params } = render(definition);
          expect(sql, value).not.toContain(TOKEN);
          expect(sql, value).not.toMatch(/drop table|pg_sleep|select email/i);
          expect(
            params.some((p) => typeof p === "string" && p.includes(TOKEN)),
            value,
          ).toBe(true);
        }
      });
    }
  }

  it("a hostile value in `in` or `eq` is refused for domain and path fields, or bound", () => {
    for (const value of HOSTILE_VALUES) {
      for (const condition of [
        { field: "data.path", op: "eq", value },
        { field: "data.path", op: "in", value: [value] },
        { field: "data.domain", op: "eq", value },
        { field: "data.domain", op: "in", value: [value] },
        { field: "data.domain", op: "domain_matches", value },
      ]) {
        const definition = { ...base, when: { all: [condition] } };
        const parsed = savedQueryDefinitionSchema.safeParse(definition);
        if (!parsed.success) {
          expect(JSON.stringify(parsed.error.issues), value).not.toContain(TOKEN);
          continue;
        }
        const { sql } = render(definition);
        expect(sql, value).not.toContain(TOKEN);
      }
    }
  });

  it("a hostile time zone is bound too", () => {
    const { sql, params } = render(base, {
      ...context,
      timeZone: `UTC'; drop table x; --${TOKEN}`,
    });
    expect(sql).not.toContain(TOKEN);
    expect(params.some((p) => typeof p === "string" && p.includes(TOKEN))).toBe(true);
  });
});

describe("hostile field names are refused, never compiled", () => {
  const FIELD_NAMES = [
    `data.domain'; drop table events; --${TOKEN}`,
    `data.domain" or "1"="1${TOKEN}`,
    `data.domain' -> 'x${TOKEN}`,
    `data.domain->>'x'${TOKEN}`,
    "data.__proto__",
    "data.constructor",
    "data.",
    "data.a.b",
    "data.domain ",
    " data.domain",
    "DATA.domain",
    "data.Domain",
    "data.domain\u0000",
    "data.dоmain", // Cyrillic о
    "id",
    "user_id",
    "userId",
    "integrationId",
    "data",
    "tags",
    "trace",
    "*",
    "",
    "(select 1)",
  ];

  it("in a condition", () => {
    for (const field of FIELD_NAMES) {
      for (const op of ["eq", "exists", "starts_with"] as const) {
        const value = op === "exists" ? true : "a";
        const error = refused({ ...base, when: { all: [{ field, op, value }] } });
        expect(error.message).toBe("Saved query definition is invalid");
      }
    }
  });

  it("in a projection", () => {
    for (const field of FIELD_NAMES.concat("data.userId", "occurredat", "OccurredAt")) {
      const error = refused({ ...base, fields: [field] });
      expect(error.message).toBe("Saved query definition is invalid");
    }
  });

  it("without echoing the submitted text in any schema issue (invariant 6)", () => {
    for (const field of FIELD_NAMES.filter((f) => f.includes(TOKEN))) {
      for (const definition of [
        { ...base, fields: [field] },
        { ...base, when: { all: [{ field, op: "exists", value: true }] } },
      ]) {
        const parsed = savedQueryDefinitionSchema.safeParse(definition);
        expect(parsed.success).toBe(false);
        expect(JSON.stringify(parsed.error?.issues)).not.toContain(TOKEN);
      }
    }
  });
});

describe("the rest of the definition is closed too", () => {
  it.each([
    ["an unknown aggregate", { when: {}, window: { kind: "today" }, aggregate: "sum_by_day" }],
    [
      "an aggregate with SQL in it",
      { when: {}, window: { kind: "today" }, aggregate: "count_by_day; drop table events" },
    ],
    ["an unknown window kind", { ...base, window: { kind: "today; drop table events" } }],
    ["a window with extra keys", { ...base, window: { kind: "today", from: "2020-01-01" } }],
    ["days as text", { ...base, window: { kind: "last_n_days", days: "1; drop" } }],
    ["fractional days", { ...base, window: { kind: "last_n_days", days: 1.5 } }],
    ["zero days", { ...base, window: { kind: "last_n_days", days: 0 } }],
    ["more days than allowed", { ...base, window: { kind: "last_n_days", days: 91 } }],
    ["a limit as text", { ...base, limit: "1000 offset 5" }],
    ["a limit as an expression", { ...base, limit: "all" }],
    ["a zero limit", { ...base, limit: 0 }],
    ["a negative limit", { ...base, limit: -1 }],
    ["a limit over the cap", { ...base, limit: SAVED_QUERY_LIMITS.rowsMax + 1 }],
    ["a fractional limit", { ...base, limit: 1.5 }],
    ["an offset", { ...base, offset: 5 }],
    ["an order", { ...base, orderBy: "id" }],
    ["a raw clause", { ...base, sql: "select 1" }],
    ["a where outside when", { ...base, where: "1=1" }],
    ["a userId", { ...base, userId: "someone-else" }],
    [
      "a source that is not an integration kind",
      {
        ...base,
        when: { source: [`http' or '1'='1${TOKEN}`] },
      },
    ],
    [
      "a type that is not an event type",
      {
        ...base,
        when: { type: [`browser.page_visited' or '1'='1${TOKEN}`] },
      },
    ],
    ["both fields and aggregate", { ...base, aggregate: "count_by_day" }],
    ["neither fields nor aggregate", { when: {}, window: { kind: "today" } }],
    ["no window", { when: {}, fields: ["type"] }],
    ["a string instead of an object", "select * from events"],
    ["null", null],
  ])("refuses %s", (_label, definition) => {
    const error = refused(definition);
    expect(error.message).toBe("Saved query definition is invalid");
  });

  it("an aggregate compiles to a query with no field list at all", () => {
    const compiled = compileSavedQuery(
      {
        when: { type: ["browser.page_visited"] },
        window: { kind: "today" },
        aggregate: "count_by_day",
      },
      context,
    );
    expect(compiled.kind).toBe("count_by_day");
    expect("fields" in compiled).toBe(false);
  });

  it("a stored definition that carries both an aggregate and fields is refused, not half-run", () => {
    refused({
      when: { type: ["browser.page_visited"] },
      window: { kind: "today" },
      aggregate: "count_by_day",
      fields: ["type", "data.path"],
    } satisfies Partial<SavedQueryDefinition>);
  });
});
