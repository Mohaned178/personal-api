/**
 * M5-04: the saved-query compiler, rendered to SQL without a database. The rule that matters is
 * invariant 7: a value from a definition is a bound parameter and never part of the SQL text, and a
 * field name from a definition is never an identifier.
 */
import { SAVED_QUERY_AGGREGATES, SAVED_QUERY_LIMITS } from "@personal-api/contracts";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  type CompileContext,
  type CompiledSavedQuery,
  compileSavedQuery,
  InvalidSavedQueryError,
} from "./saved-query.compiler";

type Json = Record<string, unknown>;

const context: CompileContext = {
  userId: "user-1",
  now: new Date("2026-10-14T12:00:00.000Z"),
  timeZone: "Europe/Berlin",
};

const render = (query: CompiledSavedQuery) => new PgDialect().sqlToQuery(query.where);

function raw(when: Json = {}, overrides: Json = {}): Json {
  return {
    when,
    window: { kind: "today" },
    fields: ["occurredAt", "data.domain", "data.path"],
    ...overrides,
  };
}

const HOSTILE = [
  "x' or '1'='1",
  "'; drop table events; --",
  '") or true --',
  "100%",
  "a_b",
  "back\\slash",
  "$99999",
  "{a:1}",
  "*",
];

describe("compileSavedQuery", () => {
  describe("bound parameters (invariant 7)", () => {
    it("never puts a condition value in the SQL text, whichever op carries it", () => {
      for (const value of HOSTILE) {
        const path = `/${value}`;
        const conditions: Json[] = [
          { field: "data.path", op: "eq", value: path },
          { field: "data.path", op: "neq", value: path },
          { field: "data.path", op: "in", value: [path, `${path}2`] },
          { field: "data.path", op: "starts_with", value: path },
          { field: "data.path", op: "ends_with", value: path },
          { field: "data.path", op: "contains", value: path },
          { field: "data.path", op: "matches_glob", value: path },
        ];
        for (const cond of conditions) {
          for (const group of ["all", "any", "none"]) {
            const query = compileSavedQuery(
              raw({ type: ["browser.page_visited"], [group]: [cond] }),
              context,
            );
            const { sql, params } = render(query);
            expect(sql, `${String(cond.op)} ${value}`).not.toContain(value);
            expect(params.length).toBeGreaterThan(0);
          }
        }
      }
    });

    it("binds domain values and numbers too", () => {
      const query = compileSavedQuery(
        raw({
          type: ["browser.focus_segment"],
          all: [
            { field: "data.domain", op: "domain_matches", value: "*.example.com" },
            { field: "data.durationMs", op: "gt", value: 123456 },
            { field: "data.startedAt", op: "lt", value: "2026-10-14T00:00:00Z" },
          ],
        }),
        context,
      );
      const { sql, params } = render(query);
      expect(sql).not.toContain("example.com");
      expect(sql).not.toContain("123456");
      expect(sql).not.toContain("2026-10-14T00:00:00Z");
      expect(params).toEqual(expect.arrayContaining([123456]));
    });

    it("binds the JSON key, the time zone, the current time and the user id", () => {
      const { sql, params } = render(
        compileSavedQuery(
          raw({ all: [{ field: "data.domain", op: "eq", value: "a.test" }], source: ["http"] }),
          context,
        ),
      );
      expect(sql).not.toContain("domain'");
      expect(sql).not.toContain("Europe/Berlin");
      expect(sql).not.toContain("2026-10-14");
      expect(sql).not.toContain("user-1");
      expect(params).toEqual(expect.arrayContaining(["domain", "Europe/Berlin", "user-1"]));
    });

    it("matches `%`, `_` and a backslash in a glob literally, as the engine does", () => {
      const { params } = render(
        compileSavedQuery(
          raw({
            type: ["browser.page_visited"],
            all: [{ field: "data.path", op: "matches_glob", value: "/100%_a\\b*c" }],
          }),
          context,
        ),
      );
      expect(params).toContain("/100\\%\\_a\\\\b%c");
    });

    it("restricts the source by a user-scoped subquery on integrations", () => {
      const { sql, params } = render(
        compileSavedQuery(raw({ source: ["browser-extension"] }), context),
      );
      expect(sql).toMatch(/"integration_id" in \(select/i);
      expect(sql).toContain('"integrations"."user_id" = $');
      expect(params.filter((p) => p === "user-1")).toHaveLength(1);
      expect(params).toContain("browser-extension");
    });
  });

  describe("definitions that do not parse (nothing is skipped)", () => {
    const bad: Array<[string, unknown]> = [
      ["not an object", "select 1"],
      ["null", null],
      ["no window", { when: {}, fields: ["type"] }],
      ["unknown key", { ...raw(), sql: "1=1" }],
      ["an unknown window", raw({}, { window: { kind: "forever" } })],
      ["an unknown aggregate", { when: {}, window: { kind: "today" }, aggregate: "sum_by_hour" }],
      ["an unknown op", raw({ all: [{ field: "data.domain", op: "regex", value: ".*" }] })],
      ["a hostile projection field", raw({}, { fields: ['data.domain" from events; --'] })],
      ["a prototype field", raw({}, { fields: ["__proto__"] })],
      [
        "a hostile condition field",
        raw({ all: [{ field: 'data.x") or (true', op: "eq", value: "a" }] }),
      ],
      ["a limit over the maximum", raw({}, { limit: SAVED_QUERY_LIMITS.rowsMax + 1 })],
      ["fields and aggregate together", raw({}, { aggregate: "count_by_day" })],
      ["neither fields nor aggregate", { when: {}, window: { kind: "today" } }],
    ];

    it.each(bad)("throws for %s", (_name, definition) => {
      expect(() => compileSavedQuery(definition, context)).toThrow(InvalidSavedQueryError);
    });

    it("does not repeat the definition's values in the error", () => {
      const secret = "secret-domain.example";
      try {
        compileSavedQuery(
          raw({ all: [{ field: "data.domain", op: "regex", value: secret }] }),
          context,
        );
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidSavedQueryError);
        expect(String((error as Error).message)).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain(secret);
      }
    });
  });

  describe("shape of the result", () => {
    it("is an events query with the projection in order, and the default row limit", () => {
      const query = compileSavedQuery(raw(), context);
      expect(query.kind).toBe("events");
      if (query.kind !== "events") return;
      expect(query.fields).toEqual(["occurredAt", "data.domain", "data.path"]);
      expect(query.limit).toBe(SAVED_QUERY_LIMITS.rowsDefault);
    });

    it("uses the definition's limit, never more than 1,000", () => {
      expect(compileSavedQuery(raw({}, { limit: 7 }), context).limit).toBe(7);
      expect(compileSavedQuery(raw({}, { limit: SAVED_QUERY_LIMITS.rowsMax }), context).limit).toBe(
        SAVED_QUERY_LIMITS.rowsMax,
      );
    });

    it("compiles every aggregate to an aggregate query with no projection at all", () => {
      for (const aggregate of SAVED_QUERY_AGGREGATES) {
        const query = compileSavedQuery(
          { when: {}, window: { kind: "last_n_days", days: 7 }, aggregate },
          context,
        );
        expect(query.kind).toBe(aggregate);
        expect(query).not.toHaveProperty("fields");
        expect(query.limit).toBe(SAVED_QUERY_LIMITS.rowsDefault);
      }
    });

    it("limits an aggregate too", () => {
      const query = compileSavedQuery(
        { when: {}, window: { kind: "today" }, aggregate: "count_by_domain", limit: 3 },
        context,
      );
      expect(query.limit).toBe(3);
    });

    it("limits duration_by_domain to focus segments", () => {
      const query = compileSavedQuery(
        {
          when: { type: ["browser.*"] },
          window: { kind: "today" },
          aggregate: "duration_by_domain",
        },
        context,
      );
      expect(render(query).params).toContain("browser.focus_segment");
    });
  });
});
