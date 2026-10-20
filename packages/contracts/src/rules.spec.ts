import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { toContractIssues } from "./errors.js";
import {
  RESERVED_ACTIONS,
  RULE_LIMITS,
  ruleDefinitionSchema,
  ruleSaveSchema,
  ruleSchema,
  SAVE_RESERVED_ACTIONS,
} from "./rules.js";

const RULE_ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";

type Json = Record<string, unknown>;

function collectRule(overrides: Json = {}): Json {
  return {
    name: "Track GitHub",
    enabled: true,
    priority: 10,
    stage: "collect",
    when: { all: [{ field: "data.domain", op: "domain_matches", value: "github.com" }] },
    then: [{ action: "allow" }],
    ...overrides,
  };
}

function processRule(overrides: Json = {}): Json {
  return collectRule({
    stage: "process",
    when: { type: ["browser.page_visited"] },
    then: [{ action: "tag", tag: "work" }],
    ...overrides,
  });
}

function without(rule: Json, key: string): Json {
  const copy = { ...rule };
  delete copy[key];
  return copy;
}

function ok(rule: unknown): boolean {
  return ruleDefinitionSchema.safeParse(rule).success;
}

function issuePaths(rule: unknown): string[] {
  const result = ruleDefinitionSchema.safeParse(rule);
  if (result.success) return [];
  return toContractIssues(result.error.issues).map((issue) => issue.path.join("."));
}

const PAGE = ["browser.page_visited"];
const SEGMENT = ["browser.focus_segment"];

describe("ruleDefinitionSchema: the PLAN §5 example", () => {
  it("accepts the example from the plan exactly as written", () => {
    const planExample = {
      name: "Track GitHub, but not settings pages",
      enabled: true,
      priority: 10,
      stage: "collect",
      when: {
        source: ["browser-extension"],
        type: ["browser.*"],
        all: [{ field: "data.domain", op: "domain_matches", value: "github.com" }],
        none: [{ field: "data.path", op: "starts_with", value: "/settings" }],
      },
      then: [{ action: "allow" }],
    };
    const result = ruleDefinitionSchema.safeParse(planExample);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(planExample);
  });

  it("accepts a rule with an empty `when` (it matches every event)", () => {
    expect(ok(collectRule({ when: {}, then: [{ action: "drop" }] }))).toBe(true);
  });
});

describe("ruleDefinitionSchema: shape", () => {
  it.each([
    ["an unknown top-level key", collectRule({ extra: 1 })],
    ["an id (server-owned)", collectRule({ id: RULE_ID })],
    ["a userId (tenancy comes from the session)", collectRule({ userId: RULE_ID })],
    ["an unknown key in `when`", collectRule({ when: { nope: [] } })],
    [
      "an unknown key in a condition",
      collectRule({
        when: { all: [{ field: "data.domain", op: "eq", value: "a.com", extra: 1 }] },
      }),
    ],
    ["an unknown key in an action", collectRule({ then: [{ action: "allow", extra: true }] })],
    ["a missing name", without(collectRule(), "name")],
    ["a missing stage", without(collectRule(), "stage")],
    ["a missing `when`", without(collectRule(), "when")],
    ["a missing `then`", without(collectRule(), "then")],
    ["a missing `enabled`", without(collectRule(), "enabled")],
    ["a missing priority", without(collectRule(), "priority")],
    ["an unknown stage", collectRule({ stage: "ingest" })],
    ["a non-boolean `enabled`", collectRule({ enabled: "yes" })],
    ["a fractional priority", collectRule({ priority: 1.5 })],
    ["a negative priority", collectRule({ priority: -1 })],
    ["a priority above the limit", collectRule({ priority: RULE_LIMITS.priorityMax + 1 })],
    ["an empty name", collectRule({ name: "" })],
    ["a blank name", collectRule({ name: "   " })],
    ["a name over the limit", collectRule({ name: "x".repeat(RULE_LIMITS.nameMax + 1) })],
    ["an empty `then`", collectRule({ then: [] })],
    [
      "too many actions",
      processRule({
        then: Array.from({ length: RULE_LIMITS.actionsMax + 1 }, (_, i) => ({
          action: "tag",
          tag: `t${i}`,
        })),
      }),
    ],
    ["null", null],
    ["an array", []],
    ["a string", "rule"],
  ])("rejects %s", (_name, rule) => {
    expect(ok(rule)).toBe(false);
  });

  it("accepts the priority limits and trims the name", () => {
    expect(ok(collectRule({ priority: 0 }))).toBe(true);
    expect(ok(collectRule({ priority: RULE_LIMITS.priorityMax }))).toBe(true);
    const result = ruleDefinitionSchema.safeParse(collectRule({ name: "  Work  " }));
    expect(result.success && result.data.name).toBe("Work");
  });

  it("ruleSchema requires a UUID id and is otherwise the same document", () => {
    expect(ruleSchema.safeParse(collectRule({ id: RULE_ID })).success).toBe(true);
    expect(ruleSchema.safeParse(collectRule()).success).toBe(false);
    expect(ruleSchema.safeParse(collectRule({ id: "not-a-uuid" })).success).toBe(false);
    expect(ruleSchema.safeParse(collectRule({ id: RULE_ID, when: { nope: 1 } })).success).toBe(
      false,
    );
  });
});

describe("ruleDefinitionSchema: `when.source` and `when.type`", () => {
  it.each([[["browser-extension"]], [["http"]], [["http", "browser-extension"]]])(
    "accepts source %j",
    (source) => {
      expect(ok(collectRule({ when: { source } }))).toBe(true);
    },
  );

  it.each([[[]], [["firefox"]], [["http", "http", "http"]], ["http"]])(
    "rejects source %j",
    (source) => {
      expect(ok(collectRule({ when: { source } }))).toBe(false);
    },
  );

  it.each([
    [["*"]],
    [["browser.*"]],
    [["browser.page_visited"]],
    [["browser.tab_*", "browser.session_started"]],
    [["*.page_visited"]],
  ])("accepts type %j", (type) => {
    expect(ok(collectRule({ when: { type } }))).toBe(true);
  });

  it.each([
    [[]],
    [["browser.page_visted"]],
    [["github.*"]],
    [["browser.page_visited", "typo.*"]],
    [["Browser.*"]],
    [["browser.page?visited"]],
    [["a*b*c*d*e*f*g*h*i*j"]],
    [["x".repeat(RULE_LIMITS.globMax + 1)]],
    [Array.from({ length: RULE_LIMITS.typesMax + 1 }, () => "*")],
    ["browser.*"],
  ])("rejects type %j", (type) => {
    expect(ok(collectRule({ when: { type } }))).toBe(false);
  });

  it("points at the type pattern that matches nothing", () => {
    expect(issuePaths(collectRule({ when: { type: ["browser.*", "typo.*"] } }))).toEqual([
      "when.type.1",
    ]);
  });
});

describe("ruleDefinitionSchema: conditions, per op", () => {
  const valid: [string, Json, string[]][] = [
    ["eq on a domain", { field: "data.domain", op: "eq", value: "github.com" }, PAGE],
    ["eq on a path", { field: "data.path", op: "eq", value: "/a/b" }, PAGE],
    ["eq on an enum", { field: "data.transition", op: "eq", value: "typed" }, PAGE],
    [
      "neq on an enum",
      { field: "data.reason", op: "neq", value: "idle" },
      ["browser.session_ended"],
    ],
    ["eq on an int", { field: "data.durationMs", op: "eq", value: 0 }, SEGMENT],
    ["neq on an int", { field: "data.durationMs", op: "neq", value: 5 }, SEGMENT],
    ["in on domains", { field: "data.domain", op: "in", value: ["a.com", "b.org"] }, PAGE],
    ["in on an enum", { field: "data.transition", op: "in", value: ["link", "typed"] }, PAGE],
    ["starts_with on a path", { field: "data.path", op: "starts_with", value: "/settings" }, PAGE],
    ["ends_with on a path", { field: "data.path", op: "ends_with", value: ".pdf" }, PAGE],
    ["contains on a path", { field: "data.path", op: "contains", value: "admin" }, PAGE],
    ["starts_with on a domain", { field: "data.domain", op: "starts_with", value: "mail." }, PAGE],
    [
      "domain_matches exact",
      { field: "data.domain", op: "domain_matches", value: "example.com" },
      PAGE,
    ],
    [
      "domain_matches wildcard",
      { field: "data.domain", op: "domain_matches", value: "*.example.com" },
      PAGE,
    ],
    [
      "matches_glob on a path",
      { field: "data.path", op: "matches_glob", value: "/u/*/settings*" },
      PAGE,
    ],
    [
      "matches_glob on a domain",
      { field: "data.domain", op: "matches_glob", value: "*.corp.*" },
      PAGE,
    ],
    ["gt on an int", { field: "data.durationMs", op: "gt", value: 1000 }, SEGMENT],
    ["lt on an int", { field: "data.durationMs", op: "lt", value: 60000.5 }, SEGMENT],
    [
      "gt on a timestamp",
      { field: "data.startedAt", op: "gt", value: "2026-01-01T00:00:00.000Z" },
      SEGMENT,
    ],
    [
      "lt on a timestamp",
      { field: "data.endedAt", op: "lt", value: "2026-12-31T23:59:59Z" },
      SEGMENT,
    ],
    ["exists true", { field: "data.transition", op: "exists", value: true }, PAGE],
    ["exists false", { field: "data.domain", op: "exists", value: false }, ["browser.tab_opened"]],
  ];

  it.each(valid)("accepts %s", (_name, cond, type) => {
    for (const group of ["all", "any", "none"] as const) {
      expect(ok(collectRule({ when: { type, [group]: [cond] } })), group).toBe(true);
    }
  });

  const invalid: [string, Json, string[]][] = [
    ["gt on a path", { field: "data.path", op: "gt", value: 1 }, PAGE],
    ["gt on a domain", { field: "data.domain", op: "gt", value: 1 }, PAGE],
    ["gt on an enum", { field: "data.transition", op: "gt", value: 1 }, PAGE],
    [
      "lt on an int with a date",
      { field: "data.durationMs", op: "lt", value: "2026-01-01T00:00:00Z" },
      SEGMENT,
    ],
    ["gt on a timestamp with a number", { field: "data.startedAt", op: "gt", value: 5 }, SEGMENT],
    [
      "gt on a timestamp with a non-UTC time",
      { field: "data.startedAt", op: "gt", value: "2026-01-01T00:00:00+02:00" },
      SEGMENT,
    ],
    [
      "gt on a timestamp with a fake date",
      { field: "data.startedAt", op: "gt", value: "2026-02-31T00:00:00Z" },
      SEGMENT,
    ],
    [
      "eq on a timestamp",
      { field: "data.startedAt", op: "eq", value: "2026-01-01T00:00:00Z" },
      SEGMENT,
    ],
    [
      "domain_matches on a path",
      { field: "data.path", op: "domain_matches", value: "a.com" },
      PAGE,
    ],
    [
      "domain_matches on an enum",
      { field: "data.reason", op: "domain_matches", value: "a.com" },
      ["browser.session_ended"],
    ],
    [
      "starts_with on an enum",
      { field: "data.reason", op: "starts_with", value: "i" },
      ["browser.session_ended"],
    ],
    ["starts_with on an int", { field: "data.durationMs", op: "starts_with", value: "1" }, SEGMENT],
    ["contains with a number", { field: "data.path", op: "contains", value: 5 }, PAGE],
    [
      "matches_glob on an int",
      { field: "data.durationMs", op: "matches_glob", value: "1*" },
      SEGMENT,
    ],
    [
      "eq on an enum with an unknown value",
      { field: "data.transition", op: "eq", value: "teleport" },
      PAGE,
    ],
    [
      "in on an enum with an unknown value",
      { field: "data.transition", op: "in", value: ["link", "teleport"] },
      PAGE,
    ],
    ["eq on an int with a string", { field: "data.durationMs", op: "eq", value: "5" }, SEGMENT],
    [
      "eq on a domain with upper case",
      { field: "data.domain", op: "eq", value: "GitHub.com" },
      PAGE,
    ],
    [
      "eq on a domain with a scheme",
      { field: "data.domain", op: "eq", value: "https://github.com" },
      PAGE,
    ],
    ["eq on a path with a query", { field: "data.path", op: "eq", value: "/a?b=1" }, PAGE],
    ["eq on a path without a slash", { field: "data.path", op: "eq", value: "a" }, PAGE],
    ["in with no values", { field: "data.domain", op: "in", value: [] }, PAGE],
    [
      "in with too many values",
      {
        field: "data.domain",
        op: "in",
        value: Array.from({ length: RULE_LIMITS.inMax + 1 }, (_, i) => `d${i}.com`),
      },
      PAGE,
    ],
    ["in with a non-array", { field: "data.domain", op: "in", value: "a.com" }, PAGE],
    ["exists with a string", { field: "data.transition", op: "exists", value: "true" }, PAGE],
    ["exists without a value", { field: "data.transition", op: "exists" }, PAGE],
    [
      "domain_matches with a bare wildcard",
      { field: "data.domain", op: "domain_matches", value: "*" },
      PAGE,
    ],
    [
      "domain_matches with a wildcard not at the start",
      { field: "data.domain", op: "domain_matches", value: "a.*.com" },
      PAGE,
    ],
    [
      "domain_matches with `*` glued to the label",
      { field: "data.domain", op: "domain_matches", value: "*example.com" },
      PAGE,
    ],
    [
      "domain_matches with two wildcards",
      { field: "data.domain", op: "domain_matches", value: "*.*.example.com" },
      PAGE,
    ],
    [
      "domain_matches with a port",
      { field: "data.domain", op: "domain_matches", value: "example.com:8080" },
      PAGE,
    ],
    [
      "domain_matches with upper case",
      { field: "data.domain", op: "domain_matches", value: "Example.com" },
      PAGE,
    ],
    [
      "matches_glob with too many wildcards",
      { field: "data.path", op: "matches_glob", value: "*a*b*c*d*e*f*g*h*i" },
      PAGE,
    ],
    [
      "matches_glob that is too long",
      { field: "data.path", op: "matches_glob", value: "a".repeat(RULE_LIMITS.valueMax + 1) },
      PAGE,
    ],
    ["starts_with with an empty value", { field: "data.path", op: "starts_with", value: "" }, PAGE],
    [
      "starts_with with a control character",
      { field: "data.path", op: "starts_with", value: "/a\u0000b" },
      PAGE,
    ],
    [
      "starts_with with a lone surrogate",
      { field: "data.path", op: "starts_with", value: "/a\ud800" },
      PAGE,
    ],
    ["a regex op", { field: "data.path", op: "matches_regex", value: ".*" }, PAGE],
    ["an unknown op", { field: "data.path", op: "sounds_like", value: "x" }, PAGE],
    ["a missing op", { field: "data.path", value: "x" }, PAGE],
    ["a missing field", { op: "eq", value: "x" }, PAGE],
    ["a non-string field", { field: 5, op: "eq", value: "x" }, PAGE],
    ["NaN", { field: "data.durationMs", op: "gt", value: Number.NaN }, SEGMENT],
  ];

  it.each(invalid)("rejects %s", (_name, cond, type) => {
    expect(ok(collectRule({ when: { type, all: [cond] } }))).toBe(false);
  });

  it.each([
    "path",
    "data",
    "data.",
    "data.nope",
    "data.path.x",
    "data.tabRef",
    "occurredAt",
    "id",
    "meta.client",
    "data.__proto__",
    "data.constructor",
    "data.toString",
    "x".repeat(200),
  ])("rejects the field %j", (field) => {
    const when = { type: PAGE, all: [{ field, op: "exists", value: true }] };
    expect(ok(collectRule({ when }))).toBe(false);
  });

  it("limits conditions per group", () => {
    const cond = { field: "data.domain", op: "eq", value: "a.com" };
    const many = (n: number) => Array.from({ length: n }, () => cond);
    for (const group of ["all", "any", "none"] as const) {
      expect(ok(collectRule({ when: { [group]: many(RULE_LIMITS.conditionsMax) } }))).toBe(true);
      expect(ok(collectRule({ when: { [group]: many(RULE_LIMITS.conditionsMax + 1) } }))).toBe(
        false,
      );
      expect(ok(collectRule({ when: { [group]: [] } }))).toBe(false);
    }
  });
});

describe("ruleDefinitionSchema: fields must exist on the selected event types", () => {
  const path = { field: "data.path", op: "starts_with", value: "/a" };

  it("an omitted `type` means every type", () => {
    expect(ok(collectRule({ when: { all: [path] } }))).toBe(true);
    expect(
      ok(collectRule({ when: { all: [{ field: "data.durationMs", op: "gt", value: 1 }] } })),
    ).toBe(true);
  });

  it("a field that exists on at least one selected type is accepted", () => {
    expect(ok(collectRule({ when: { type: ["browser.*"], all: [path] } }))).toBe(true);
    expect(
      ok(
        collectRule({
          when: { type: ["browser.page_visited", "browser.tab_opened"], all: [path] },
        }),
      ),
    ).toBe(true);
  });

  it("rejects a field that none of the selected types has", () => {
    expect(ok(collectRule({ when: { type: ["browser.tab_opened"], all: [path] } }))).toBe(false);
    expect(ok(collectRule({ when: { type: ["browser.session_*"], all: [path] } }))).toBe(false);
    const unknown = { field: "data.x", op: "exists", value: true };
    expect(
      issuePaths(collectRule({ when: { type: ["browser.tab_opened"], none: [unknown, path] } })),
    ).toEqual(["when.none.0.field", "when.none.1.field"]);
  });

  it("allows the op by kind, and a value that fits at least one selected type", () => {
    const reason = (value: string) => ({ field: "data.reason", op: "eq", value });
    const when = (value: string) => ({ type: ["browser.session_*"], all: [reason(value)] });
    expect(ok(collectRule({ when: when("idle") }))).toBe(true);
    expect(ok(collectRule({ when: when("startup") }))).toBe(true);
    expect(ok(collectRule({ when: when("teleport") }))).toBe(false);
  });

  it("points at the exact condition and part that is wrong", () => {
    const badOp = { field: "data.path", op: "gt", value: 1 };
    expect(issuePaths(collectRule({ when: { type: PAGE, any: [path, badOp] } }))).toEqual([
      "when.any.1.op",
    ]);
    const badValue = { field: "data.transition", op: "eq", value: "teleport" };
    expect(issuePaths(collectRule({ when: { type: PAGE, all: [badValue] } }))).toEqual([
      "when.all.0.value",
    ]);
  });
});

describe("ruleDefinitionSchema: actions and stages", () => {
  const onPage = (then: Json[]) => collectRule({ when: { type: PAGE }, then });

  it.each([
    ["allow", { action: "allow" }],
    ["drop", { action: "drop" }],
    ["keep_query", { action: "keep_query" }],
    ["coarsen to 2 segments", { action: "coarsen", segments: 2 }],
    ["coarsen to none", { action: "coarsen", segments: 0 }],
    ["redact an optional field", { action: "redact", field: "data.transition" }],
  ])("collect stage accepts %s", (_name, action) => {
    expect(ok(onPage([action]))).toBe(true);
  });

  it.each([
    ["tag", { action: "tag", tag: "work" }],
    ["set_retention", { action: "set_retention", days: 30 }],
  ])("process stage accepts %s", (_name, action) => {
    expect(ok(processRule({ then: [action] }))).toBe(true);
  });

  it.each([
    ["allow", { action: "allow" }],
    ["drop", { action: "drop" }],
    ["redact", { action: "redact", field: "data.transition" }],
    ["coarsen", { action: "coarsen", segments: 1 }],
    ["keep_query", { action: "keep_query" }],
  ])("process stage rejects %s", (_name, action) => {
    expect(ok(processRule({ then: [action] }))).toBe(false);
  });

  it.each([
    ["tag", { action: "tag", tag: "work" }],
    ["set_retention", { action: "set_retention", days: 30 }],
  ])("collect stage rejects %s", (_name, action) => {
    expect(ok(collectRule({ then: [action] }))).toBe(false);
  });

  it("points at the action that does not belong to the stage", () => {
    const then = [{ action: "tag", tag: "a" }, { action: "drop" }];
    expect(issuePaths(processRule({ then }))).toEqual(["then.1.action"]);
  });

  it.each([
    ["forward", { action: "forward", url: "https://example.com/hook" }],
    ["forward without params", { action: "forward" }],
    ["an unknown action", { action: "exfiltrate" }],
    ["a code action", { action: "eval", code: "1+1" }],
    ["a missing action", {}],
    ["coarsen with segments 11", { action: "coarsen", segments: 11 }],
    ["coarsen with -1", { action: "coarsen", segments: -1 }],
    ["coarsen with 1.5", { action: "coarsen", segments: 1.5 }],
    ["coarsen without segments", { action: "coarsen" }],
    ["redact without a field", { action: "redact" }],
    ["redact of an unknown field", { action: "redact", field: "data.nope" }],
    ["redact of a required field", { action: "redact", field: "data.domain" }],
    ["allow with params", { action: "allow", field: "data.domain" }],
  ])("collect stage rejects %s", (_name, action) => {
    expect(ok(onPage([action]))).toBe(false);
  });

  it.each([
    ["tag without a name", { action: "tag" }],
    ["tag with upper case", { action: "tag", tag: "Work" }],
    ["tag with a space", { action: "tag", tag: "my tag" }],
    ["an empty tag", { action: "tag", tag: "" }],
    ["a tag over the limit", { action: "tag", tag: "a".repeat(RULE_LIMITS.tagMax + 1) }],
    ["a tag starting with a symbol", { action: "tag", tag: "-work" }],
    ["set_retention 0", { action: "set_retention", days: 0 }],
    [
      "set_retention over the limit",
      { action: "set_retention", days: RULE_LIMITS.retentionDaysMax + 1 },
    ],
    ["set_retention 1.5", { action: "set_retention", days: 1.5 }],
    ["set_retention as a string", { action: "set_retention", days: "30" }],
    ["set_retention without days", { action: "set_retention" }],
  ])("process stage rejects %s", (_name, action) => {
    expect(ok(processRule({ then: [action] }))).toBe(false);
  });

  it("accepts tags with digits and the allowed punctuation", () => {
    for (const tag of ["work", "a1", "client_x", "project-2", "team.alpha", "area:ops", "0day"]) {
      expect(ok(processRule({ then: [{ action: "tag", tag }] })), tag).toBe(true);
    }
  });

  it("reserves the names in RESERVED_ACTIONS and rejects them on save", () => {
    expect(RESERVED_ACTIONS).toContain("forward");
    for (const action of RESERVED_ACTIONS) {
      expect(ok(collectRule({ then: [{ action }] }))).toBe(false);
      expect(ok(processRule({ then: [{ action }] }))).toBe(false);
    }
  });

  it("allows at most one terminal action", () => {
    expect(ok(onPage([{ action: "allow" }, { action: "drop" }]))).toBe(false);
    expect(ok(onPage([{ action: "drop" }, { action: "drop" }]))).toBe(false);
    expect(ok(onPage([{ action: "allow" }, { action: "allow" }]))).toBe(false);
  });

  it("allows transforms with or without a terminal action, in any order", () => {
    const coarsen = { action: "coarsen", segments: 1 };
    expect(ok(onPage([coarsen, { action: "allow" }]))).toBe(true);
    expect(ok(onPage([{ action: "allow" }, coarsen]))).toBe(true);
    expect(ok(onPage([coarsen]))).toBe(true);
  });

  it("rejects duplicate actions but allows several redacts of different fields", () => {
    const redactTransition = { action: "redact", field: "data.transition" };
    expect(
      ok(
        onPage([
          { action: "coarsen", segments: 1 },
          { action: "coarsen", segments: 2 },
        ]),
      ),
    ).toBe(false);
    expect(ok(onPage([{ action: "keep_query" }, { action: "keep_query" }]))).toBe(false);
    expect(ok(onPage([redactTransition, redactTransition]))).toBe(false);
    expect(
      ok(
        collectRule({
          when: { type: ["browser.tab_opened"] },
          then: [{ action: "redact", field: "data.domain" }, { action: "allow" }],
        }),
      ),
    ).toBe(true);
    expect(
      ok(
        processRule({
          then: [
            { action: "tag", tag: "a" },
            { action: "tag", tag: "a" },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      ok(
        processRule({
          then: [
            { action: "tag", tag: "a" },
            { action: "tag", tag: "b" },
            { action: "set_retention", days: 7 },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      ok(
        processRule({
          then: [
            { action: "set_retention", days: 7 },
            { action: "set_retention", days: 8 },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("redact: the field must be optional on every selected type that has it", () => {
    const redactDomain = [{ action: "redact", field: "data.domain" }];
    expect(ok(collectRule({ when: { type: ["browser.tab_*"] }, then: redactDomain }))).toBe(true);
    // `domain` is required on page_visited, so a rule that can reach it may not redact it.
    expect(ok(collectRule({ when: {}, then: redactDomain }))).toBe(false);
    expect(ok(collectRule({ when: { type: ["browser.*"] }, then: redactDomain }))).toBe(false);
    // Not present on any selected type.
    expect(ok(collectRule({ when: { type: ["browser.session_*"] }, then: redactDomain }))).toBe(
      false,
    );
  });

  it("coarsen: at least one selected type must have a path", () => {
    const coarsen = (type: string[], segments = 1) =>
      collectRule({ when: { type }, then: [{ action: "coarsen", segments }] });
    expect(ok(coarsen(PAGE))).toBe(true);
    expect(ok(coarsen(SEGMENT, 0))).toBe(true);
    expect(ok(coarsen(["browser.*"]))).toBe(true);
    expect(ok(coarsen(["browser.tab_*"]))).toBe(false);
    expect(ok(coarsen(["browser.session_started"]))).toBe(false);
  });
});

describe("ruleDefinitionSchema: safety", () => {
  it("never echoes input values in its issues (they may be domains or paths)", () => {
    const sentinel = "secret-sentinel-xyz.example";
    const attempts = [
      collectRule({ when: { all: [{ field: "data.domain", op: "eq", value: `${sentinel}:80` }] } }),
      collectRule({ when: { all: [{ field: sentinel, op: "eq", value: "a.com" }] } }),
      collectRule({ when: { type: [sentinel] } }),
      collectRule({ when: { all: [{ field: "data.path", op: "gt", value: sentinel }] } }),
      collectRule({ name: sentinel, [sentinel]: 1 }),
      collectRule({ then: [{ action: sentinel }] }),
      collectRule({ when: { [sentinel]: [] } }),
      collectRule({
        when: { type: PAGE },
        then: [{ action: "redact", field: sentinel }],
      }),
    ];
    for (const attempt of attempts) {
      const result = ruleDefinitionSchema.safeParse(attempt);
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(JSON.stringify(toContractIssues(result.error.issues))).not.toContain(sentinel);
    }
  });

  it("does not mutate its input", () => {
    const input = collectRule({ name: "  Padded  " });
    const snapshot = structuredClone(input);
    ruleDefinitionSchema.safeParse(input);
    expect(input).toEqual(snapshot);
  });

  it("is idempotent: parsing its own output gives the same rule", () => {
    const input = collectRule({
      name: "  Padded  ",
      when: { type: ["browser.*"], none: [{ field: "data.path", op: "starts_with", value: "/x" }] },
      then: [{ action: "coarsen", segments: 2 }, { action: "allow" }],
    });
    const first = ruleDefinitionSchema.parse(input);
    expect(ruleDefinitionSchema.parse(first)).toEqual(first);
  });

  it("never throws on arbitrary JSON, and never accepts it", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(ruleDefinitionSchema.safeParse(value).success).toBe(false);
      }),
    );
  });

  it("never throws on a valid rule with one part replaced by arbitrary JSON", () => {
    const keys = ["name", "enabled", "priority", "stage", "when", "then"];
    fc.assert(
      fc.property(fc.constantFrom(...keys), fc.jsonValue(), (key, value) => {
        expect(() =>
          ruleDefinitionSchema.safeParse({ ...collectRule(), [key]: value }),
        ).not.toThrow();
      }),
    );
  });
});

// M7-R: `keep_query` is reserved for v1.1. The save path rejects it with a stable, fixed message
// (as it does `forward`), while stored rules that already use it still load and run.
describe("ruleSaveSchema: keep_query is reserved for v1.1", () => {
  const withKeepQuery = collectRule({ then: [{ action: "allow" }, { action: "keep_query" }] });

  it("names keep_query as the one save-reserved action", () => {
    expect(SAVE_RESERVED_ACTIONS).toEqual(["keep_query"]);
  });

  it("rejects it on save, pointing at the action with a fixed message", () => {
    const result = ruleSaveSchema.safeParse(withKeepQuery);
    expect(result.success).toBe(false);
    if (result.success) return;
    const issues = toContractIssues(result.error.issues);
    expect(issues.map((issue) => issue.path.join("."))).toEqual(["then.1.action"]);
    expect(JSON.stringify(issues)).not.toContain("github.com");
  });

  it("still accepts every other action", () => {
    expect(ruleSaveSchema.safeParse(collectRule()).success).toBe(true);
    expect(ruleSaveSchema.safeParse(processRule()).success).toBe(true);
    const coarsen = collectRule({
      then: [{ action: "allow" }, { action: "coarsen", segments: 1 }],
    });
    expect(ruleSaveSchema.safeParse(coarsen).success).toBe(true);
  });

  it("does not make the engine's schemas stricter: a stored rule with keep_query still loads", () => {
    expect(ok(withKeepQuery)).toBe(true);
    expect(ruleSchema.safeParse({ id: RULE_ID, ...withKeepQuery }).success).toBe(true);
  });
});
