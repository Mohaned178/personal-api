import { type KnownEvent, parseEvent } from "@personal-api/contracts";
import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluate.js";
import {
  compile,
  focusSegment,
  pageVisited,
  rule,
  ruleId,
  tabOpened,
  UUID_V7,
} from "./test-helpers.js";
import type { CompiledRuleSet, EvaluateContext, EvaluationResult } from "./types.js";

const EXT: EvaluateContext = { source: "browser-extension" };
const NO_RULES = compile([]);

function allowed(result: EvaluationResult) {
  if (result.decision !== "allow") throw new Error(`expected allow, got ${result.decision}`);
  return result;
}

function dropped(result: EvaluationResult) {
  if (result.decision !== "drop") throw new Error(`expected drop, got ${result.decision}`);
  return result;
}

function domainIs(domain: string) {
  return { all: [{ field: "data.domain", op: "eq", value: domain }] };
}

describe("evaluate: the default policy decides when no rule does", () => {
  it("deny drops, and the trace says the default policy decided", () => {
    const result = dropped(evaluate(pageVisited(), NO_RULES, "deny", EXT));
    expect(result.trace).toEqual({ ruleSetVersion: 7, matched: [], decidedBy: "default_policy" });
  });

  it("allow keeps the event as it is", () => {
    const input = pageVisited();
    const result = allowed(evaluate(input, NO_RULES, "allow", EXT));
    expect(result.event).toEqual(
      parseEvent(input).ok && (parseEvent(input) as { event: KnownEvent }).event,
    );
    expect(result.trace.decidedBy).toBe("default_policy");
    expect(result).toMatchObject({ tags: [], retentionDays: null, keepQuery: false });
  });

  it("rules that do not match leave the decision to the policy", () => {
    const rules = compile([rule(1, { when: domainIs("example.org") })]);
    expect(evaluate(pageVisited(), rules, "deny", EXT).decision).toBe("drop");
    expect(evaluate(pageVisited(), rules, "allow", EXT).decision).toBe("allow");
  });

  it("anything but the exact policy `allow` is treated as deny", () => {
    for (const policy of ["deny", "ALLOW", "", null, undefined, 1, {}]) {
      const result = evaluate(pageVisited(), NO_RULES, policy as never, EXT);
      expect(result.decision).not.toBe("allow");
    }
  });
});

describe("evaluate: rules decide", () => {
  it("an allow rule collects the event and is named in the trace", () => {
    const rules = compile([rule(1, { when: domainIs("github.com") })]);
    const result = allowed(evaluate(pageVisited(), rules, "deny", EXT));
    expect(result.trace).toEqual({
      ruleSetVersion: 7,
      matched: [{ ruleId: ruleId(1), actions: ["allow"] }],
      decidedBy: ruleId(1),
    });
  });

  it("a drop rule drops the event even when the policy is allow", () => {
    const rules = compile([rule(1, { when: domainIs("github.com"), then: [{ action: "drop" }] })]);
    const result = dropped(evaluate(pageVisited(), rules, "allow", EXT));
    expect(result.trace.decidedBy).toBe(ruleId(1));
  });

  it("a dropped result has no event at all (nothing to store)", () => {
    const rules = compile([rule(1, { then: [{ action: "drop" }] })]);
    const result = evaluate(pageVisited(), rules, "allow", EXT);
    expect(Object.keys(result).sort()).toEqual(["decision", "trace"]);
  });

  it("the first deciding rule by priority wins: lower number first", () => {
    const allowFirst = compile([
      rule(1, { priority: 10 }),
      rule(2, { priority: 20, then: [{ action: "drop" }] }),
    ]);
    expect(allowed(evaluate(pageVisited(), allowFirst, "deny", EXT)).trace.decidedBy).toBe(
      ruleId(1),
    );

    const dropFirst = compile([
      rule(1, { priority: 20 }),
      rule(2, { priority: 10, then: [{ action: "drop" }] }),
    ]);
    expect(dropped(evaluate(pageVisited(), dropFirst, "allow", EXT)).trace.decidedBy).toBe(
      ruleId(2),
    );
  });

  it("at the same priority drop beats allow, whatever the ids or the input order", () => {
    const allowRule = rule(1, { priority: 5 });
    const dropRule = rule(9, { priority: 5, then: [{ action: "drop" }] });
    for (const rules of [
      [allowRule, dropRule],
      [dropRule, allowRule],
    ]) {
      const result = dropped(evaluate(pageVisited(), compile(rules), "allow", EXT));
      expect(result.trace.decidedBy).toBe(ruleId(9));
    }
    const lowIdDrop = rule(1, { priority: 5, then: [{ action: "drop" }] });
    const highIdAllow = rule(9, { priority: 5 });
    expect(evaluate(pageVisited(), compile([highIdAllow, lowIdDrop]), "allow", EXT).decision).toBe(
      "drop",
    );
  });

  it("disabled rules are ignored", () => {
    const rules = compile([rule(1, { enabled: false, then: [{ action: "drop" }] })]);
    expect(evaluate(pageVisited(), rules, "allow", EXT).decision).toBe("allow");
  });

  it("a rule that only transforms does not decide", () => {
    const rules = compile([rule(1, { then: [{ action: "coarsen", segments: 1 }] })]);
    expect(evaluate(pageVisited(), rules, "deny", EXT).decision).toBe("drop");
    const result = allowed(evaluate(pageVisited(), rules, "allow", EXT));
    expect(result.trace.decidedBy).toBe("default_policy");
    expect(result.trace.matched).toEqual([{ ruleId: ruleId(1), actions: ["coarsen"] }]);
  });

  it("a rule after the deciding one is still listed as matched", () => {
    const rules = compile([
      rule(1, { priority: 1 }),
      rule(2, { priority: 2, then: [{ action: "drop" }] }),
    ]);
    const result = allowed(evaluate(pageVisited(), rules, "deny", EXT));
    expect(result.trace.matched.map((m) => m.ruleId)).toEqual([ruleId(1), ruleId(2)]);
    expect(result.trace.decidedBy).toBe(ruleId(1));
  });
});

describe("evaluate: `when`", () => {
  const github = (when: Record<string, unknown>) => compile([rule(1, { when })]);
  const decide = (when: Record<string, unknown>, event = pageVisited(), ctx = EXT) =>
    evaluate(event, github(when), "deny", ctx).decision;

  it("an empty `when` matches every event", () => {
    expect(decide({})).toBe("allow");
    expect(decide({}, tabOpened())).toBe("allow");
  });

  it("source matches the integration kind", () => {
    expect(decide({ source: ["browser-extension"] })).toBe("allow");
    expect(decide({ source: ["http"] })).toBe("drop");
    expect(decide({ source: ["http", "browser-extension"] })).toBe("allow");
    expect(decide({ source: ["browser-extension"] }, pageVisited(), { source: "http" })).toBe(
      "drop",
    );
  });

  it("type matches with the glob", () => {
    expect(decide({ type: ["browser.page_visited"] })).toBe("allow");
    expect(decide({ type: ["browser.*"] })).toBe("allow");
    expect(decide({ type: ["browser.tab_*"] })).toBe("drop");
    expect(decide({ type: ["browser.tab_*", "browser.page_*"] })).toBe("allow");
  });

  it("all needs every condition, any at least one, none zero", () => {
    const domain = { field: "data.domain", op: "eq", value: "github.com" };
    const other = { field: "data.domain", op: "eq", value: "example.org" };
    const settings = { field: "data.path", op: "starts_with", value: "/Mohaned178" };
    expect(decide({ all: [domain, settings] })).toBe("allow");
    expect(decide({ all: [domain, other] })).toBe("drop");
    expect(decide({ any: [other, domain] })).toBe("allow");
    expect(decide({ any: [other] })).toBe("drop");
    expect(decide({ none: [other] })).toBe("allow");
    expect(decide({ none: [other, domain] })).toBe("drop");
  });

  it("every present part must hold", () => {
    const domain = { field: "data.domain", op: "eq", value: "github.com" };
    expect(decide({ source: ["browser-extension"], type: ["browser.*"], all: [domain] })).toBe(
      "allow",
    );
    expect(decide({ source: ["http"], type: ["browser.*"], all: [domain] })).toBe("drop");
    expect(decide({ source: ["browser-extension"], type: ["browser.tab_*"], all: [domain] })).toBe(
      "drop",
    );
  });

  it("the example from the plan: GitHub, but not the settings pages", () => {
    const rules = compile([
      rule(1, {
        priority: 10,
        when: {
          source: ["browser-extension"],
          type: ["browser.*"],
          all: [{ field: "data.domain", op: "domain_matches", value: "github.com" }],
          none: [{ field: "data.path", op: "starts_with", value: "/settings" }],
        },
      }),
    ]);
    const run = (event: Record<string, unknown>) => evaluate(event, rules, "deny", EXT).decision;
    expect(run(pageVisited({ path: "/Mohaned178/IdentiK" }))).toBe("allow");
    expect(run(pageVisited({ path: "/settings/profile" }))).toBe("drop");
    expect(run(pageVisited({ domain: "example.org" }))).toBe("drop");
    expect(run(tabOpened())).toBe("allow");
    expect(run(tabOpened({ domain: "example.org" }))).toBe("drop");
  });
});

describe("evaluate: conditions on a missing field", () => {
  it("are false for every op, so the rule does not match", () => {
    const noDomain = tabOpened({ domain: undefined });
    const ops = [
      { op: "eq", value: "a.com" },
      { op: "neq", value: "a.com" },
      { op: "in", value: ["a.com"] },
      { op: "starts_with", value: "a" },
      { op: "ends_with", value: "m" },
      { op: "contains", value: "." },
      { op: "domain_matches", value: "a.com" },
      { op: "matches_glob", value: "*" },
      { op: "exists", value: true },
    ];
    for (const cond of ops) {
      const rules = compile([
        rule(1, {
          when: { type: ["browser.tab_opened"], all: [{ field: "data.domain", ...cond }] },
        }),
      ]);
      expect(evaluate(noDomain, rules, "deny", EXT).decision, cond.op).toBe("drop");
    }
  });

  it("`exists: false` is true, and a `none` on a missing field is satisfied", () => {
    const noDomain = tabOpened({ domain: undefined });
    const absent = compile([
      rule(1, {
        when: {
          type: ["browser.tab_opened"],
          all: [{ field: "data.domain", op: "exists", value: false }],
        },
      }),
    ]);
    expect(evaluate(noDomain, absent, "deny", EXT).decision).toBe("allow");
    expect(evaluate(tabOpened(), absent, "deny", EXT).decision).toBe("drop");
    const none = compile([
      rule(1, { when: { none: [{ field: "data.path", op: "starts_with", value: "/x" }] } }),
    ]);
    expect(evaluate(tabOpened(), none, "deny", EXT).decision).toBe("allow");
  });
});

describe("evaluate: each op, once (the full tables are M4-03)", () => {
  const holds = (cond: Record<string, unknown>, event = pageVisited()) =>
    evaluate(event, compile([rule(1, { when: { all: [cond] } })]), "deny", EXT).decision ===
    "allow";

  it.each([
    [{ field: "data.domain", op: "eq", value: "github.com" }, true],
    [{ field: "data.domain", op: "eq", value: "gitlab.com" }, false],
    [{ field: "data.domain", op: "neq", value: "gitlab.com" }, true],
    [{ field: "data.domain", op: "neq", value: "github.com" }, false],
    [{ field: "data.domain", op: "in", value: ["a.com", "github.com"] }, true],
    [{ field: "data.domain", op: "in", value: ["a.com"] }, false],
    [{ field: "data.path", op: "starts_with", value: "/Mohaned" }, true],
    [{ field: "data.path", op: "starts_with", value: "/mohaned" }, false],
    [{ field: "data.path", op: "ends_with", value: "IdentiK" }, true],
    [{ field: "data.path", op: "ends_with", value: "Identi" }, false],
    [{ field: "data.path", op: "contains", value: "178/Id" }, true],
    [{ field: "data.path", op: "contains", value: "178/id" }, false],
    [{ field: "data.domain", op: "domain_matches", value: "github.com" }, true],
    [{ field: "data.domain", op: "domain_matches", value: "*.github.com" }, false],
    [{ field: "data.path", op: "matches_glob", value: "/Mohaned178/*" }, true],
    [{ field: "data.path", op: "matches_glob", value: "/other/*" }, false],
    [{ field: "data.transition", op: "exists", value: true }, true],
    [{ field: "data.transition", op: "exists", value: false }, false],
    [{ field: "data.transition", op: "eq", value: "link" }, true],
  ])("%j is %s", (cond, expected) => {
    expect(holds(cond)).toBe(expected);
  });

  it("domain_matches: `*.x` matches subdomains of any depth, not the apex", () => {
    const on = (domain: string, pattern: string) =>
      holds(
        { field: "data.domain", op: "domain_matches", value: pattern },
        pageVisited({ domain }),
      );
    expect(on("gist.github.com", "*.github.com")).toBe(true);
    expect(on("a.b.github.com", "*.github.com")).toBe(true);
    expect(on("github.com", "*.github.com")).toBe(false);
    expect(on("notgithub.com", "*.github.com")).toBe(false);
    expect(on("gist.github.com", "github.com")).toBe(false);
  });

  it("gt and lt compare numbers and UTC times", () => {
    const seg = focusSegment();
    expect(holds({ field: "data.durationMs", op: "gt", value: 299_999 }, seg)).toBe(true);
    expect(holds({ field: "data.durationMs", op: "gt", value: 300_000 }, seg)).toBe(false);
    expect(holds({ field: "data.durationMs", op: "lt", value: 300_001 }, seg)).toBe(true);
    expect(holds({ field: "data.durationMs", op: "lt", value: 300_000 }, seg)).toBe(false);
    expect(
      holds({ field: "data.startedAt", op: "gt", value: "2026-10-13T09:59:59.999Z" }, seg),
    ).toBe(true);
    expect(holds({ field: "data.startedAt", op: "gt", value: "2026-10-13T10:00:00Z" }, seg)).toBe(
      false,
    );
    expect(holds({ field: "data.endedAt", op: "lt", value: "2026-10-13T10:05:00.001Z" }, seg)).toBe(
      true,
    );
    expect(holds({ field: "data.endedAt", op: "lt", value: "2026-10-13T10:05:00.000Z" }, seg)).toBe(
      false,
    );
  });
});

describe("evaluate: collect transforms", () => {
  const allowAnd = (...then: Record<string, unknown>[]) =>
    compile([rule(1, { priority: 10, then: [...then, { action: "allow" }] })]);

  it("coarsen keeps the first N path segments", () => {
    const run = (path: string, segments: number) =>
      allowed(
        evaluate(pageVisited({ path }), allowAnd({ action: "coarsen", segments }), "deny", EXT),
      ).event;
    expect(run("/a/b/c", 2).data).toMatchObject({ path: "/a/b" });
    expect(run("/a/b/c", 1).data).toMatchObject({ path: "/a" });
    expect(run("/a/b/c", 0).data).toMatchObject({ path: "/" });
    expect(run("/a/b", 5).data).toMatchObject({ path: "/a/b" });
    expect(run("/", 2).data).toMatchObject({ path: "/" });
    expect(run("/a/b/c/", 3).data).toMatchObject({ path: "/a/b/c" });
    expect(run("/a/b/c/", 4).data).toMatchObject({ path: "/a/b/c/" });
  });

  it("coarsen applies to focus segments, and leaves events without a path alone", () => {
    const rules = allowAnd({ action: "coarsen", segments: 1 });
    expect(
      allowed(evaluate(focusSegment({ path: "/x/y" }), rules, "deny", EXT)).event.data,
    ).toMatchObject({ path: "/x" });
    const tab = allowed(evaluate(tabOpened(), rules, "deny", EXT)).event;
    expect(tab.data).toEqual({ tabRef: "k3j2h1g4f5d6a7b8", domain: "github.com" });
  });

  it("redact removes an optional field and leaves a valid event", () => {
    const result = allowed(
      evaluate(
        pageVisited(),
        allowAnd({ action: "redact", field: "data.transition" }),
        "deny",
        EXT,
      ),
    );
    expect(result.event.data).not.toHaveProperty("transition");
    expect(parseEvent(result.event).ok).toBe(true);
    const tab = allowed(
      evaluate(
        tabOpened(),
        compile([
          rule(1, {
            when: { type: ["browser.tab_*"] },
            then: [{ action: "redact", field: "data.domain" }, { action: "allow" }],
          }),
        ]),
        "deny",
        EXT,
      ),
    );
    expect(tab.event.data).toEqual({ tabRef: "k3j2h1g4f5d6a7b8" });
  });

  it("redacting a field that is already missing is a no-op", () => {
    const rules = compile([
      rule(1, {
        when: { type: ["browser.page_visited"] },
        then: [{ action: "redact", field: "data.transition" }, { action: "allow" }],
      }),
    ]);
    const result = allowed(evaluate(pageVisited({ transition: undefined }), rules, "deny", EXT));
    expect(result.event.data).not.toHaveProperty("transition");
  });

  it("keep_query is reported, and changes nothing else", () => {
    const result = allowed(
      evaluate(pageVisited(), allowAnd({ action: "keep_query" }), "deny", EXT),
    );
    expect(result.keepQuery).toBe(true);
    expect(result.event).toEqual(allowed(evaluate(pageVisited(), NO_RULES, "allow", EXT)).event);
  });

  it("transforms of every matching rule apply, whichever rule decides", () => {
    const rules = compile([
      rule(1, { priority: 10, when: domainIs("github.com") }),
      rule(2, { priority: 50, then: [{ action: "coarsen", segments: 1 }] }),
    ]);
    const result = allowed(evaluate(pageVisited({ path: "/a/b/c" }), rules, "deny", EXT));
    expect(result.trace.decidedBy).toBe(ruleId(1));
    expect(result.event.data).toMatchObject({ path: "/a" });
  });

  it("transforms run in priority order, then `then` order", () => {
    const rules = compile([
      rule(1, { priority: 1, then: [{ action: "coarsen", segments: 3 }] }),
      rule(2, { priority: 2, then: [{ action: "coarsen", segments: 1 }, { action: "allow" }] }),
      rule(3, { priority: 3, then: [{ action: "coarsen", segments: 2 }] }),
    ]);
    // 3 segments, then 1, then 2 is a no-op on "/a".
    expect(
      allowed(evaluate(pageVisited({ path: "/a/b/c/d" }), rules, "deny", EXT)).event.data,
    ).toMatchObject({ path: "/a" });
  });

  it("conditions are checked against the original event, not the transformed one", () => {
    // A coarsen at priority 5 must not hide the path from the drop rule at priority 10.
    const rules = compile([
      rule(1, { priority: 5, then: [{ action: "coarsen", segments: 0 }] }),
      rule(2, {
        priority: 10,
        when: { all: [{ field: "data.path", op: "starts_with", value: "/private" }] },
        then: [{ action: "drop" }],
      }),
    ]);
    expect(evaluate(pageVisited({ path: "/private/notes" }), rules, "allow", EXT).decision).toBe(
      "drop",
    );
    expect(
      allowed(evaluate(pageVisited({ path: "/public/notes" }), rules, "allow", EXT)).event.data,
    ).toMatchObject({ path: "/" });
  });

  it("a dropped event runs no further rules", () => {
    const rules = compile([
      rule(1, { priority: 1, then: [{ action: "drop" }] }),
      rule(2, { priority: 2 }),
    ]);
    const result = dropped(evaluate(pageVisited(), rules, "allow", EXT));
    expect(result.trace.matched).toEqual([{ ruleId: ruleId(1), actions: ["drop"] }]);
  });

  it("does not mutate the input event", () => {
    const input = pageVisited({ path: "/a/b/c" });
    const snapshot = JSON.parse(JSON.stringify(input));
    evaluate(
      input,
      allowAnd({ action: "coarsen", segments: 1 }, { action: "redact", field: "data.transition" }),
      "deny",
      EXT,
    );
    expect(input).toEqual(snapshot);
  });

  it("is idempotent: evaluating the output again gives the same event", () => {
    const rules = allowAnd(
      { action: "coarsen", segments: 2 },
      { action: "redact", field: "data.transition" },
    );
    const first = allowed(evaluate(pageVisited({ path: "/a/b/c/d" }), rules, "deny", EXT));
    const second = allowed(evaluate(first.event, rules, "deny", EXT));
    expect(second.event).toEqual(first.event);
  });

  // KNOWN LIMITATION (docs/rule-format.md, open item 1). Conditions look at the incoming event, so
  // an event that a rule rewrote can stop matching that same rule when the server evaluates it
  // again (PLAN §3 re-applies the collect rules). This pins today's behaviour; if the design
  // changes, change this test with it.
  it("known limitation: an allowed, rewritten event can be dropped when evaluated again", () => {
    const rules = compile([
      rule(1, {
        priority: 10,
        when: { all: [{ field: "data.path", op: "starts_with", value: "/work/" }] },
        then: [{ action: "coarsen", segments: 1 }, { action: "allow" }],
      }),
    ]);
    const first = allowed(
      evaluate(pageVisited({ path: "/work/projectA/doc" }), rules, "deny", EXT),
    );
    expect(first.event.data).toMatchObject({ path: "/work" });
    expect(evaluate(first.event, rules, "deny", EXT).decision).toBe("drop");

    const redactRules = compile([
      rule(2, {
        when: {
          type: ["browser.page_visited"],
          all: [{ field: "data.transition", op: "exists", value: true }],
        },
        then: [{ action: "redact", field: "data.transition" }, { action: "allow" }],
      }),
    ]);
    const redacted = allowed(evaluate(pageVisited(), redactRules, "deny", EXT));
    expect(evaluate(redacted.event, redactRules, "deny", EXT).decision).toBe("drop");
  });

  it("fails closed when a transform would leave an invalid event", () => {
    // Not a set that `compileRuleSet` can produce: redacting a required field is rejected there.
    const bad: CompiledRuleSet = {
      version: 1,
      collect: [
        rule(1, { then: [{ action: "redact", field: "data.domain" }, { action: "allow" }] }),
      ],
      process: [],
    };
    expect(evaluate(pageVisited(), bad, "allow", EXT)).toEqual({
      decision: "error",
      reason: "invalid_result",
    });
  });
});

describe("evaluate: the process stage", () => {
  const tagRule = (n: number, tag: string, extra: Record<string, unknown> = {}) =>
    rule(n, { stage: "process", then: [{ action: "tag", tag }], ...extra });

  it("adds tags from matching process rules, once each, in rule order", () => {
    const rules = compile([
      rule(1),
      tagRule(2, "work", { priority: 2 }),
      tagRule(3, "code", { priority: 1 }),
      tagRule(4, "work", { priority: 3 }),
      tagRule(5, "nope", { when: domainIs("example.org") }),
    ]);
    const result = allowed(evaluate(pageVisited(), rules, "deny", EXT));
    expect(result.tags).toEqual(["code", "work"]);
    expect(result.trace.matched.map((m) => m.ruleId)).toEqual([
      ruleId(1),
      ruleId(3),
      ruleId(2),
      ruleId(4),
    ]);
  });

  it("set_retention: the smallest number of days wins", () => {
    const retention = (n: number, days: number) =>
      rule(n, { stage: "process", then: [{ action: "set_retention", days }] });
    const rules = compile([rule(1), retention(2, 30), retention(3, 7), retention(4, 90)]);
    expect(allowed(evaluate(pageVisited(), rules, "deny", EXT)).retentionDays).toBe(7);
  });

  it("does not run for a dropped event, and cannot rescue one", () => {
    const rules = compile([tagRule(1, "work")]);
    const result = dropped(evaluate(pageVisited(), rules, "deny", EXT));
    expect(result.trace.matched).toEqual([]);
  });

  it("does not run when the context turns it off (the extension)", () => {
    const rules = compile([rule(1), tagRule(2, "work")]);
    const result = allowed(
      evaluate(pageVisited(), rules, "deny", { source: "browser-extension", process: false }),
    );
    expect(result.tags).toEqual([]);
    expect(result.trace.matched.map((m) => m.ruleId)).toEqual([ruleId(1)]);
  });

  it("matches against the event that will be stored, so a tag cannot reveal redacted data", () => {
    const rules = compile([
      rule(1, { then: [{ action: "coarsen", segments: 0 }, { action: "allow" }] }),
      tagRule(2, "secret-section", {
        when: { all: [{ field: "data.path", op: "starts_with", value: "/secret" }] },
      }),
      tagRule(3, "root", { when: { all: [{ field: "data.path", op: "eq", value: "/" }] } }),
    ]);
    const result = allowed(evaluate(pageVisited({ path: "/secret/plans" }), rules, "deny", EXT));
    expect(result.tags).toEqual(["root"]);
  });

  it("process rules never change the event", () => {
    const rules = compile([rule(1), tagRule(2, "work")]);
    const withTags = allowed(evaluate(pageVisited(), rules, "deny", EXT));
    const plain = allowed(evaluate(pageVisited(), compile([rule(1)]), "deny", EXT));
    expect(withTags.event).toEqual(plain.event);
  });
});

describe("evaluate: fails closed", () => {
  const rules = compile([rule(1)]);

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "event"],
    ["an array", []],
    ["an empty object", {}],
    ["an unknown type", { ...pageVisited(), type: "browser.nope" }],
    ["an unknown key", { ...pageVisited(), extra: 1 }],
    ["a path with a query string", pageVisited({ path: "/a?token=1" })],
    ["a server-owned field", { ...pageVisited(), userId: UUID_V7 }],
  ])("%s is an error, not a decision", (_name, event) => {
    expect(evaluate(event, rules, "allow", EXT)).toEqual({
      decision: "error",
      reason: "invalid_event",
    });
  });

  it("an unknown source is an error", () => {
    for (const source of ["firefox", "", null, undefined]) {
      expect(evaluate(pageVisited(), rules, "allow", { source } as never)).toEqual({
        decision: "error",
        reason: "invalid_context",
      });
    }
  });

  it("a malformed rule set is an error and never throws", () => {
    const broken = [
      null,
      undefined,
      { version: 1 },
      { version: 1, collect: null, process: [] },
      { version: 1, collect: [null], process: [] },
      { version: 1, collect: [{ ...rule(1), when: null }], process: [] },
      { version: 1, collect: [{ ...rule(1), then: "allow" }], process: [] },
      {
        version: 1,
        collect: [{ ...rule(1), when: { all: [{ field: "data.domain", op: "bogus", value: 1 }] } }],
        process: [],
      },
    ];
    for (const ruleSet of broken) {
      const run = () => evaluate(pageVisited(), ruleSet as never, "allow", EXT);
      expect(run).not.toThrow();
      expect(run().decision, JSON.stringify(ruleSet)).toBe("error");
    }
  });

  it("an error result carries no event and no trace", () => {
    const result = evaluate(null, rules, "allow", EXT);
    expect(Object.keys(result).sort()).toEqual(["decision", "reason"]);
  });
});

describe("evaluate: purity", () => {
  it("gives the same answer every time", () => {
    const rules = compile([
      rule(1, { then: [{ action: "coarsen", segments: 1 }, { action: "allow" }] }),
    ]);
    const a = evaluate(pageVisited({ path: "/a/b" }), rules, "deny", EXT);
    const b = evaluate(pageVisited({ path: "/a/b" }), rules, "deny", EXT);
    expect(a).toEqual(b);
  });

  it("does not mutate the compiled rule set", () => {
    const rules = compile([
      rule(1, { then: [{ action: "coarsen", segments: 1 }, { action: "allow" }] }),
    ]);
    const snapshot = JSON.parse(JSON.stringify(rules));
    evaluate(pageVisited({ path: "/a/b" }), rules, "deny", EXT);
    expect(rules).toEqual(snapshot);
  });
});
