import { describe, expect, it } from "vitest";
import { toContractIssues } from "./errors.js";
import {
  SAVED_QUERY_AGGREGATES,
  SAVED_QUERY_FIELDS,
  SAVED_QUERY_LIMITS,
  savedQueryDefinitionSchema,
  savedQueryFieldKey,
} from "./saved-query.js";

type Json = Record<string, unknown>;

function rawQuery(overrides: Json = {}): Json {
  return {
    when: { type: ["browser.page_visited"] },
    window: { kind: "today" },
    fields: ["occurredAt", "data.domain"],
    ...overrides,
  };
}

function aggregateQuery(aggregate: string, overrides: Json = {}): Json {
  return { when: {}, window: { kind: "last_n_days", days: 7 }, aggregate, ...overrides };
}

const ok = (value: unknown) => savedQueryDefinitionSchema.safeParse(value).success;

describe("savedQueryDefinitionSchema", () => {
  it("accepts a raw projection and each aggregate", () => {
    expect(ok(rawQuery())).toBe(true);
    for (const aggregate of SAVED_QUERY_AGGREGATES)
      expect(ok(aggregateQuery(aggregate))).toBe(true);
  });

  it("uses the condition language of rules inside `when`", () => {
    const when = {
      source: ["browser-extension"],
      type: ["browser.*"],
      all: [{ field: "data.domain", op: "domain_matches", value: "github.com" }],
      none: [{ field: "data.path", op: "starts_with", value: "/settings" }],
    };
    expect(ok(rawQuery({ when }))).toBe(true);
    expect(ok(aggregateQuery("count_by_day", { when }))).toBe(true);
  });

  it("rejects the same conditions rules reject, with an issue path inside `when`", () => {
    const bad = (cond: Json) =>
      savedQueryDefinitionSchema.safeParse(rawQuery({ when: { all: [cond] } }));
    const unknownField = bad({ field: "data.nope", op: "eq", value: "x" });
    expect(unknownField.success).toBe(false);
    if (!unknownField.success) {
      expect(unknownField.error.issues[0]?.path).toEqual(["when", "all", 0, "field"]);
    }
    expect(bad({ field: "data.domain", op: "gt", value: 3 }).success).toBe(false);
    expect(bad({ field: "data.domain", op: "eq", value: "Not A Domain" }).success).toBe(false);
    // No regex and no code, ever (invariant 8).
    expect(bad({ field: "data.domain", op: "regex", value: ".*" }).success).toBe(false);
    expect(
      savedQueryDefinitionSchema.safeParse(rawQuery({ when: { type: ["browser.page_visted"] } }))
        .success,
    ).toBe(false);
  });

  it("is strict: unknown keys are rejected at every level", () => {
    expect(ok(rawQuery({ userId: "someone" }))).toBe(false);
    expect(ok(rawQuery({ integrationId: "x" }))).toBe(false);
    expect(ok(rawQuery({ sql: "select 1" }))).toBe(false);
    expect(ok(rawQuery({ window: { kind: "today", days: 3 } }))).toBe(false);
    expect(ok(rawQuery({ when: { type: ["browser.*"], where: "1=1" } }))).toBe(false);
  });

  it("needs a window: there is no unbounded query", () => {
    const { window: _window, ...rest } = rawQuery();
    expect(ok(rest)).toBe(false);
  });

  describe("windows", () => {
    it("accepts today, this_week and last_n_days", () => {
      expect(ok(rawQuery({ window: { kind: "today" } }))).toBe(true);
      expect(ok(rawQuery({ window: { kind: "this_week" } }))).toBe(true);
      expect(ok(rawQuery({ window: { kind: "last_n_days", days: 1 } }))).toBe(true);
      expect(
        ok(rawQuery({ window: { kind: "last_n_days", days: SAVED_QUERY_LIMITS.lastDaysMax } })),
      ).toBe(true);
    });

    it("rejects unknown kinds and out-of-range or non-integer days", () => {
      expect(ok(rawQuery({ window: { kind: "forever" } }))).toBe(false);
      expect(ok(rawQuery({ window: { kind: "last_n_days" } }))).toBe(false);
      for (const days of [0, -1, 1.5, SAVED_QUERY_LIMITS.lastDaysMax + 1, "7", null]) {
        expect(ok(rawQuery({ window: { kind: "last_n_days", days } })), String(days)).toBe(false);
      }
    });
  });

  describe("projection (raw events)", () => {
    it("allows type, occurredAt and the data fields of the registry", () => {
      expect(SAVED_QUERY_FIELDS).toEqual(
        expect.arrayContaining([
          "type",
          "occurredAt",
          "data.domain",
          "data.path",
          "data.durationMs",
        ]),
      );
      for (const field of SAVED_QUERY_FIELDS) {
        expect(ok(rawQuery({ when: {}, fields: [field] })), field).toBe(true);
      }
    });

    it("never allows ids, tags, trace, tabRef, the integration or anything not listed", () => {
      for (const field of [
        "id",
        "tags",
        "trace",
        "data",
        "data.tabRef",
        "data.__proto__",
        "__proto__",
        "constructor",
        "userId",
        "integrationId",
        "receivedAt",
        "data.domain; drop table events",
        'data."domain"',
        "*",
        "",
      ]) {
        expect(ok(rawQuery({ fields: [field] })), field).toBe(false);
      }
    });

    it("rejects duplicates and an empty list", () => {
      expect(ok(rawQuery({ fields: [] }))).toBe(false);
      expect(ok(rawQuery({ fields: ["type", "type"] }))).toBe(false);
      expect(ok(rawQuery({ when: {}, fields: [...SAVED_QUERY_FIELDS, "type"] }))).toBe(false);
      expect(ok(rawQuery({ when: {}, fields: [...SAVED_QUERY_FIELDS] }))).toBe(true);
    });

    it("rejects a field that none of the selected event types has", () => {
      expect(ok(rawQuery({ when: { type: ["browser.tab_opened"] }, fields: ["data.path"] }))).toBe(
        false,
      );
      expect(
        ok(rawQuery({ when: { type: ["browser.tab_opened"] }, fields: ["data.domain"] })),
      ).toBe(true);
      expect(
        ok(rawQuery({ when: { type: ["browser.session_started"] }, fields: ["data.reason"] })),
      ).toBe(true);
    });

    it("maps a field to its output key without the data. prefix", () => {
      expect(savedQueryFieldKey("data.domain")).toBe("domain");
      expect(savedQueryFieldKey("occurredAt")).toBe("occurredAt");
      expect(savedQueryFieldKey("type")).toBe("type");
    });

    it("has output keys that never collide", () => {
      const keys = SAVED_QUERY_FIELDS.map(savedQueryFieldKey);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  describe("aggregate-only", () => {
    it("needs exactly one of fields and aggregate", () => {
      const { fields: _fields, ...noFields } = rawQuery();
      expect(ok(noFields)).toBe(false); // neither: nothing says what to return
      for (const aggregate of SAVED_QUERY_AGGREGATES) {
        expect(ok(rawQuery({ aggregate })), aggregate).toBe(false); // both
      }
    });

    it("rejects an unknown aggregate", () => {
      expect(ok(aggregateQuery("sum_by_hour"))).toBe(false);
      expect(ok(aggregateQuery("count_by_day; select 1"))).toBe(false);
    });

    it("needs a focus segment for duration_by_domain and a domain for count_by_domain", () => {
      expect(
        ok(aggregateQuery("duration_by_domain", { when: { type: ["browser.page_visited"] } })),
      ).toBe(false);
      expect(
        ok(aggregateQuery("duration_by_domain", { when: { type: ["browser.focus_segment"] } })),
      ).toBe(true);
      expect(ok(aggregateQuery("duration_by_domain", { when: { type: ["browser.*"] } }))).toBe(
        true,
      );
      expect(ok(aggregateQuery("count_by_domain", { when: { type: ["browser.session_*"] } }))).toBe(
        false,
      );
      expect(ok(aggregateQuery("count_by_domain", { when: { type: ["browser.tab_*"] } }))).toBe(
        true,
      );
    });
  });

  describe("limit", () => {
    it("is 1 to 1000, an integer", () => {
      expect(ok(rawQuery({ limit: 1 }))).toBe(true);
      expect(ok(rawQuery({ limit: SAVED_QUERY_LIMITS.rowsMax }))).toBe(true);
      for (const limit of [0, -5, 1.5, SAVED_QUERY_LIMITS.rowsMax + 1, "10", null]) {
        expect(ok(rawQuery({ limit })), String(limit)).toBe(false);
      }
    });

    it("caps rows at 1,000 (PLAN §6)", () => {
      expect(SAVED_QUERY_LIMITS.rowsMax).toBe(1000);
    });
  });

  it("never repeats the submitted values in issues (invariant 6)", () => {
    const secret = "secret-domain.example";
    const result = savedQueryDefinitionSchema.safeParse(
      rawQuery({
        when: { all: [{ field: "data.domain", op: "gt", value: secret }] },
        fields: [secret],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success)
      expect(JSON.stringify(toContractIssues(result.error.issues))).not.toContain(secret);
  });
});
