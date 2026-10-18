/**
 * Table tests (M4-03): every op, every action, and the `source`/`type` selectors, one row per
 * case, edge cases included. The behaviour is `docs/rule-format.md`, not the implementation:
 * a row says what the document promises. The properties live in `evaluate.property.spec.ts`.
 */
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

function allowed(result: EvaluationResult) {
  if (result.decision !== "allow") throw new Error(`expected allow, got ${result.decision}`);
  return result;
}

/** Does `cond` hold for `event`? A single `all` rule under `deny`: allow means it matched. */
function holds(cond: Record<string, unknown>, event: Record<string, unknown> = pageVisited()) {
  const rules = compile([rule(1, { when: { all: [cond] } })]);
  return evaluate(event, rules, "deny", EXT).decision === "allow";
}

type Row = [field: string, value: unknown, event: Record<string, unknown>, expected: boolean];

function check(op: string, rows: Row[]) {
  it.each(rows)(`${op} on %s with %j (event %#) is %s`, (field, value, event, expected) => {
    expect(holds({ field, op, value }, event)).toBe(expected);
  });
}

const GITHUB = pageVisited();
/** A tab event without the optional domain. */
const BARE_TAB = {
  id: UUID_V7,
  type: "browser.tab_opened",
  typeVersion: 1,
  occurredAt: "2026-10-13T10:05:00.000Z",
  data: { tabRef: "k3j2h1g4f5d6a7b8" },
};
const at = (path: string) => pageVisited({ path });
const on = (domain: string) => pageVisited({ domain });

describe("op eq", () => {
  check("eq", [
    ["data.domain", "github.com", GITHUB, true],
    ["data.domain", "gitlab.com", GITHUB, false],
    ["data.domain", "github.co", GITHUB, false],
    ["data.domain", "gist.github.com", GITHUB, false],
    ["data.path", "/a/b", at("/a/b"), true],
    ["data.path", "/a/b", at("/a/b/"), false],
    ["data.path", "/a/b", at("/a"), false],
    ["data.path", "/Mohaned178/IdentiK", GITHUB, true],
    ["data.path", "/mohaned178/identik", GITHUB, false],
    ["data.path", "/", at("/"), true],
    ["data.path", "/é", at("/é"), true],
    ["data.transition", "link", GITHUB, true],
    ["data.transition", "typed", GITHUB, false],
    ["data.durationMs", 300_000, focusSegment(), true],
    ["data.durationMs", 299_999, focusSegment(), false],
  ]);

  it("eq on an enum of a session event", () => {
    const started = {
      id: UUID_V7,
      type: "browser.session_started",
      typeVersion: 1,
      occurredAt: "2026-10-13T10:05:00.000Z",
      data: { reason: "startup" },
    };
    expect(holds({ field: "data.reason", op: "eq", value: "startup" }, started)).toBe(true);
    expect(holds({ field: "data.reason", op: "eq", value: "resume" }, started)).toBe(false);
  });
});

describe("op neq", () => {
  check("neq", [
    ["data.domain", "gitlab.com", GITHUB, true],
    ["data.domain", "github.com", GITHUB, false],
    ["data.path", "/a/b", at("/a/b/"), true],
    ["data.path", "/mohaned178/identik", GITHUB, true],
    ["data.path", "/Mohaned178/IdentiK", GITHUB, false],
    ["data.transition", "typed", GITHUB, true],
    ["data.transition", "link", GITHUB, false],
    ["data.durationMs", 1, focusSegment(), true],
    ["data.durationMs", 300_000, focusSegment(), false],
  ]);

  it("neq on a missing field is false, not true (a missing field matches nothing)", () => {
    const noTransition = pageVisited();
    delete (noTransition.data as Record<string, unknown>).transition;
    expect(holds({ field: "data.transition", op: "neq", value: "typed" }, noTransition)).toBe(
      false,
    );
    expect(holds({ field: "data.domain", op: "neq", value: "github.com" }, BARE_TAB)).toBe(false);
  });
});

describe("op in", () => {
  check("in", [
    ["data.domain", ["github.com"], GITHUB, true],
    ["data.domain", ["a.com", "github.com", "b.com"], GITHUB, true],
    ["data.domain", ["a.com", "b.com"], GITHUB, false],
    ["data.domain", ["gist.github.com"], GITHUB, false],
    ["data.path", ["/x", "/a/b"], at("/a/b"), true],
    ["data.path", ["/x", "/a/b"], at("/a/b/"), false],
    ["data.path", ["/mohaned178/identik"], GITHUB, false],
    ["data.transition", ["typed", "link"], GITHUB, true],
    ["data.transition", ["typed", "reload"], GITHUB, false],
  ]);

  it("accepts the maximum of 50 entries", () => {
    const domains = Array.from({ length: 49 }, (_, i) => `site${i}.com`);
    expect(holds({ field: "data.domain", op: "in", value: [...domains, "github.com"] })).toBe(true);
    expect(holds({ field: "data.domain", op: "in", value: [...domains, "other.com"] })).toBe(false);
  });
});

describe("op starts_with", () => {
  check("starts_with", [
    ["data.path", "/Mohaned", GITHUB, true],
    ["data.path", "/mohaned", GITHUB, false],
    ["data.path", "/Mohaned178/IdentiK", GITHUB, true],
    ["data.path", "/Mohaned178/IdentiKK", GITHUB, false],
    ["data.path", "/", GITHUB, true],
    ["data.path", "/settings", at("/settings/profile"), true],
    ["data.path", "/settings", at("/settingsx"), true],
    ["data.path", "/settings/", at("/settings"), false],
    ["data.path", "IdentiK", GITHUB, false],
    ["data.domain", "git", GITHUB, true],
    ["data.domain", "hub", GITHUB, false],
    ["data.domain", "GIT", GITHUB, false],
    ["data.path", "/é", at("/ete"), false],
    ["data.path", "/é", at("/école"), true],
  ]);
});

describe("op ends_with", () => {
  check("ends_with", [
    ["data.path", "IdentiK", GITHUB, true],
    ["data.path", "identik", GITHUB, false],
    ["data.path", "/Mohaned178/IdentiK", GITHUB, true],
    ["data.path", "x/Mohaned178/IdentiK", GITHUB, false],
    ["data.path", "/b", at("/a/b"), true],
    ["data.path", "/b", at("/a/b/"), false],
    ["data.path", "Mohaned", GITHUB, false],
    ["data.domain", ".com", GITHUB, true],
    ["data.domain", "hub.com", GITHUB, true],
    ["data.domain", "hub.COM", GITHUB, false],
    ["data.domain", "github", GITHUB, false],
  ]);
});

describe("op contains", () => {
  check("contains", [
    ["data.path", "178/Id", GITHUB, true],
    ["data.path", "178/id", GITHUB, false],
    ["data.path", "Mohaned", GITHUB, true],
    ["data.path", "IdentiK", GITHUB, true],
    ["data.path", "/Mohaned178/IdentiK", GITHUB, true],
    ["data.path", "nothing", GITHUB, false],
    ["data.path", "//", at("/a//b"), true],
    ["data.path", "?", GITHUB, false],
    ["data.domain", "hub", GITHUB, true],
    ["data.domain", "git", GITHUB, true],
    ["data.domain", "HUB", GITHUB, false],
    ["data.domain", ".", GITHUB, true],
  ]);
});

describe("op domain_matches", () => {
  check("domain_matches", [
    // an exact domain matches only itself
    ["data.domain", "github.com", on("github.com"), true],
    ["data.domain", "github.com", on("gist.github.com"), false],
    ["data.domain", "github.com", on("notgithub.com"), false],
    ["data.domain", "github.com", on("github.com.evil.org"), false],
    // `*.x` matches one or more labels to the left, never the apex
    ["data.domain", "*.github.com", on("gist.github.com"), true],
    ["data.domain", "*.github.com", on("a.b.c.github.com"), true],
    ["data.domain", "*.github.com", on("github.com"), false],
    ["data.domain", "*.github.com", on("notgithub.com"), false],
    ["data.domain", "*.github.com", on("evilgithub.com"), false],
    ["data.domain", "*.github.com", on("github.com.evil.org"), false],
    ["data.domain", "*.github.com", on("gist.github.co"), false],
    ["data.domain", "*.com", on("github.com"), true],
    ["data.domain", "*.co.uk", on("bbc.co.uk"), true],
    ["data.domain", "*.co.uk", on("co.uk"), false],
  ]);

  it("the apex needs its own entry: both patterns together cover a domain and its subdomains", () => {
    const rules = compile([
      rule(1, {
        when: {
          any: [
            { field: "data.domain", op: "domain_matches", value: "github.com" },
            { field: "data.domain", op: "domain_matches", value: "*.github.com" },
          ],
        },
      }),
    ]);
    for (const domain of ["github.com", "gist.github.com", "a.b.github.com"]) {
      expect(evaluate(on(domain), rules, "deny", EXT).decision, domain).toBe("allow");
    }
    for (const domain of ["notgithub.com", "github.org"]) {
      expect(evaluate(on(domain), rules, "deny", EXT).decision, domain).toBe("drop");
    }
  });

  it("works on an optional domain, and a missing one does not match", () => {
    expect(
      holds({ field: "data.domain", op: "domain_matches", value: "*.github.com" }, tabOpened()),
    ).toBe(false);
    expect(
      holds(
        { field: "data.domain", op: "domain_matches", value: "*.github.com" },
        tabOpened({ domain: "gist.github.com" }),
      ),
    ).toBe(true);
  });
});

describe("op matches_glob", () => {
  check("matches_glob", [
    ["data.path", "*", GITHUB, true],
    ["data.path", "/*", GITHUB, true],
    ["data.path", "/Mohaned178/*", GITHUB, true],
    ["data.path", "/Mohaned178/IdentiK", GITHUB, true],
    ["data.path", "/Mohaned178/Identi", GITHUB, false],
    ["data.path", "Mohaned178/*", GITHUB, false],
    ["data.path", "/other/*", GITHUB, false],
    ["data.path", "/mohaned178/*", GITHUB, false],
    // `*` crosses `/` and may match nothing
    ["data.path", "/a/*", at("/a/b/c/d"), true],
    ["data.path", "/a/*", at("/a/"), true],
    ["data.path", "/a/*", at("/a"), false],
    ["data.path", "/a*", at("/a"), true],
    ["data.path", "/a*b", at("/a/b/c/b"), true],
    ["data.path", "/a*b", at("/a/b/c"), false],
    ["data.path", "*/b", at("/a/b"), true],
    ["data.path", "*b*", at("/a/b/c"), true],
    ["data.path", "*x*", at("/a/b/c"), false],
    ["data.path", "/*/*/*", at("/a/b/c"), true],
    ["data.path", "/*/*/*", at("/a/b"), false],
    // everything else is literal: no `?`, `[]`, `.`, `(` or `+` magic
    ["data.path", "/a?c", at("/abc"), false],
    ["data.path", "/a?c", at("/a?c"), false],
    ["data.path", "/[ab]", at("/a"), false],
    ["data.path", "/[ab]", at("/[ab]"), true],
    ["data.path", "/a.c", at("/abc"), false],
    ["data.path", "/a.c", at("/a.c"), true],
    ["data.path", "/(a)", at("/(a)"), true],
    ["data.path", "/a+", at("/aa"), false],
    ["data.path", "/a+", at("/a+"), true],
    ["data.path", "/\\d", at("/1"), false],
    ["data.domain", "*.com", GITHUB, true],
    ["data.domain", "git*", GITHUB, true],
    ["data.domain", "*hub*", GITHUB, true],
    ["data.domain", "*.org", GITHUB, false],
    ["data.domain", "GIT*", GITHUB, false],
  ]);

  it("does not blow up on a worst-case pattern (no regex, bounded work)", () => {
    const started = Date.now();
    const result = holds(
      { field: "data.path", op: "matches_glob", value: "/*a*a*a*a*a*a*a*b" },
      at(`/${"a".repeat(250)}`),
    );
    expect(result).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("op gt and lt", () => {
  const seg = focusSegment();
  check("gt", [
    ["data.durationMs", 299_999, seg, true],
    ["data.durationMs", 300_000, seg, false],
    ["data.durationMs", 300_001, seg, false],
    ["data.durationMs", -1, seg, true],
    ["data.startedAt", "2026-10-13T09:59:59.999Z", seg, true],
    ["data.startedAt", "2026-10-13T10:00:00Z", seg, false],
    ["data.startedAt", "2026-10-13T10:00:00.000Z", seg, false],
    ["data.startedAt", "2026-10-13T10:00:00.001Z", seg, false],
    ["data.startedAt", "2025-01-01T00:00:00Z", seg, true],
    ["data.startedAt", "2027-01-01T00:00:00Z", seg, false],
  ]);
  check("lt", [
    ["data.durationMs", 300_001, seg, true],
    ["data.durationMs", 300_000, seg, false],
    ["data.durationMs", 299_999, seg, false],
    ["data.endedAt", "2026-10-13T10:05:00.001Z", seg, true],
    ["data.endedAt", "2026-10-13T10:05:00.000Z", seg, false],
    ["data.endedAt", "2026-10-13T10:05:00Z", seg, false],
    ["data.endedAt", "2026-10-13T10:04:59.999Z", seg, false],
    ["data.endedAt", "2027-01-01T00:00:00Z", seg, true],
  ]);

  it("compares times as instants, not as text (a different precision is the same instant)", () => {
    expect(holds({ field: "data.startedAt", op: "gt", value: "2026-10-13T10:00:00Z" }, seg)).toBe(
      false,
    );
    expect(holds({ field: "data.startedAt", op: "lt", value: "2026-10-13T10:00:00Z" }, seg)).toBe(
      false,
    );
    expect(holds({ field: "data.startedAt", op: "lt", value: "2026-10-13T10:00:00.5Z" }, seg)).toBe(
      true,
    );
  });
});

describe("op exists", () => {
  const noTransition = pageVisited();
  delete (noTransition.data as Record<string, unknown>).transition;

  check("exists", [
    ["data.transition", true, GITHUB, true],
    ["data.transition", false, GITHUB, false],
    ["data.transition", true, noTransition, false],
    ["data.transition", false, noTransition, true],
    ["data.domain", true, GITHUB, true],
    ["data.domain", false, GITHUB, false],
    ["data.domain", true, tabOpened(), true],
    ["data.domain", false, tabOpened(), false],
    ["data.domain", true, BARE_TAB, false],
    ["data.domain", false, BARE_TAB, true],
  ]);

  it("a tab event without a domain: exists false is true, every other op is false", () => {
    const bare = BARE_TAB;
    expect(holds({ field: "data.domain", op: "exists", value: false }, bare)).toBe(true);
    expect(holds({ field: "data.domain", op: "exists", value: true }, bare)).toBe(false);
    for (const cond of [
      { field: "data.domain", op: "eq", value: "github.com" },
      { field: "data.domain", op: "neq", value: "github.com" },
      { field: "data.domain", op: "in", value: ["github.com"] },
      { field: "data.domain", op: "starts_with", value: "git" },
      { field: "data.domain", op: "ends_with", value: ".com" },
      { field: "data.domain", op: "contains", value: "git" },
      { field: "data.domain", op: "domain_matches", value: "github.com" },
      { field: "data.domain", op: "matches_glob", value: "*" },
    ]) {
      expect(holds(cond, bare), cond.op).toBe(false);
    }
  });
});

describe("ops the engine does not know fail closed", () => {
  const makeSet = (then: unknown[], when: unknown = {}): CompiledRuleSet => ({
    version: 1,
    collect: [rule(1, { when, then })],
    process: [],
  });

  it.each([
    ["regex", { field: "data.path", op: "matches_regex", value: ".*" }],
    ["matches", { field: "data.path", op: "matches", value: ".*" }],
    ["an empty op", { field: "data.path", op: "", value: "x" }],
    ["a missing op", { field: "data.path", value: "x" }],
    ["a prototype key", { field: "data.path", op: "constructor", value: "x" }],
  ])(
    "%s is an error (never read as false, which could let a drop rule fall through)",
    (_n, cond) => {
      const set = makeSet([{ action: "drop" }], { all: [cond] });
      expect(evaluate(pageVisited(), set, "allow", EXT)).toEqual({
        decision: "error",
        reason: "failed",
      });
    },
  );

  it.each([
    ["forward", { action: "forward" }],
    ["exec", { action: "exec" }],
    ["an empty action", { action: "" }],
    ["a missing action", {}],
  ])("action %s is an error", (_n, action) => {
    const set = makeSet([action, { action: "allow" }]);
    expect(evaluate(pageVisited(), set, "allow", EXT)).toEqual({
      decision: "error",
      reason: "failed",
    });
  });
});

describe("selector: source", () => {
  const forSource = (source: unknown) => compile([rule(1, { when: { source } })]);

  it.each([
    [["browser-extension"], "browser-extension", "allow"],
    [["browser-extension"], "http", "drop"],
    [["http"], "http", "allow"],
    [["http"], "browser-extension", "drop"],
    [["browser-extension", "http"], "http", "allow"],
    [["browser-extension", "http"], "browser-extension", "allow"],
  ])("source %j for an event from %s is %s", (source, from, expected) => {
    const result = evaluate(pageVisited(), forSource(source), "deny", { source: from as never });
    expect(result.decision).toBe(expected);
  });

  it("no source selector means every source", () => {
    const rules = compile([rule(1)]);
    for (const source of ["browser-extension", "http"] as const) {
      expect(evaluate(pageVisited(), rules, "deny", { source }).decision).toBe("allow");
    }
  });
});

describe("selector: type", () => {
  const withType = (type: string[]) => compile([rule(1, { when: { type } })]);
  const session = {
    id: UUID_V7,
    type: "browser.session_started",
    typeVersion: 1,
    occurredAt: "2026-10-13T10:05:00.000Z",
    data: { reason: "startup" },
  };

  it.each([
    [["browser.*"], pageVisited(), "allow"],
    [["browser.*"], tabOpened(), "allow"],
    [["browser.*"], focusSegment(), "allow"],
    [["browser.*"], session, "allow"],
    [["browser.page_visited"], pageVisited(), "allow"],
    [["browser.page_visited"], tabOpened(), "drop"],
    [["browser.tab_*"], tabOpened(), "allow"],
    [["browser.tab_*"], pageVisited(), "drop"],
    [["browser.*_started"], session, "allow"],
    [["browser.*_started"], pageVisited(), "drop"],
    [["*"], pageVisited(), "allow"],
    [["browser.page_visited", "browser.tab_opened"], tabOpened(), "allow"],
    [["browser.page_visited", "browser.tab_opened"], focusSegment(), "drop"],
    [["browser.session_*"], session, "allow"],
    [["browser.session_*"], focusSegment(), "drop"],
  ])("type %j on %#: %s", (patterns, event, expected) => {
    expect(evaluate(event, withType(patterns), "deny", EXT).decision).toBe(expected);
  });
});

describe("actions: allow and drop", () => {
  it("allow alone collects under a deny policy", () => {
    expect(evaluate(pageVisited(), compile([rule(1)]), "deny", EXT).decision).toBe("allow");
  });

  it("drop alone drops under an allow policy", () => {
    const rules = compile([rule(1, { then: [{ action: "drop" }] })]);
    expect(evaluate(pageVisited(), rules, "allow", EXT).decision).toBe("drop");
  });

  it("drop with transforms still drops, and nothing of the event comes back", () => {
    const rules = compile([
      rule(1, { then: [{ action: "coarsen", segments: 1 }, { action: "drop" }] }),
    ]);
    const result = evaluate(pageVisited(), rules, "allow", EXT);
    expect(result.decision).toBe("drop");
    expect(Object.keys(result).sort()).toEqual(["decision", "trace"]);
  });
});

describe("action: redact", () => {
  const redact = (...then: Record<string, unknown>[]) =>
    compile([
      rule(1, { when: { type: ["browser.page_visited"] }, then: [...then, { action: "allow" }] }),
    ]);

  it("removes the optional field and keeps everything else", () => {
    const result = allowed(
      evaluate(pageVisited(), redact({ action: "redact", field: "data.transition" }), "deny", EXT),
    );
    expect(result.event.data).toEqual({
      domain: "github.com",
      path: "/Mohaned178/IdentiK",
      tabRef: "k3j2h1g4f5d6a7b8",
    });
  });

  it("redacting a field the event does not carry changes nothing", () => {
    const input = pageVisited();
    delete (input.data as Record<string, unknown>).transition;
    const result = allowed(
      evaluate(input, redact({ action: "redact", field: "data.transition" }), "deny", EXT),
    );
    expect(result.event.data).not.toHaveProperty("transition");
  });

  it("redacts only on events that match the rule", () => {
    const rules = compile([
      rule(1, {
        when: {
          type: ["browser.page_visited"],
          all: [{ field: "data.domain", op: "eq", value: "example.org" }],
        },
        then: [{ action: "redact", field: "data.transition" }],
      }),
      rule(2, { priority: 200 }),
    ]);
    const kept = allowed(evaluate(pageVisited(), rules, "deny", EXT));
    expect(kept.event.data).toHaveProperty("transition", "link");
    const redacted = allowed(evaluate(on("example.org"), rules, "deny", EXT));
    expect(redacted.event.data).not.toHaveProperty("transition");
  });

  it("redacts the optional domain of a tab event", () => {
    const rules = compile([
      rule(1, {
        when: { type: ["browser.tab_*"] },
        then: [{ action: "redact", field: "data.domain" }, { action: "allow" }],
      }),
    ]);
    const result = allowed(evaluate(tabOpened(), rules, "deny", EXT));
    expect(result.event.data).toEqual({ tabRef: "k3j2h1g4f5d6a7b8" });
  });

  it("never touches the envelope", () => {
    const result = allowed(
      evaluate(pageVisited(), redact({ action: "redact", field: "data.transition" }), "deny", EXT),
    );
    expect(result.event).toMatchObject({
      id: UUID_V7,
      type: "browser.page_visited",
      typeVersion: 1,
      occurredAt: "2026-10-13T10:05:00.000Z",
    });
  });
});

describe("action: coarsen", () => {
  const coarsened = (segments: number, path: string) => {
    const rules = compile([
      rule(1, { then: [{ action: "coarsen", segments }, { action: "allow" }] }),
    ]);
    const result = allowed(evaluate(at(path), rules, "deny", EXT));
    return (result.event.data as { path: string }).path;
  };

  it.each([
    [0, "/", "/"],
    [0, "/a", "/"],
    [0, "/a/b/c", "/"],
    [1, "/", "/"],
    [1, "/a", "/a"],
    [1, "/a/b/c", "/a"],
    [2, "/a/b/c", "/a/b"],
    [3, "/a/b/c", "/a/b/c"],
    [4, "/a/b/c", "/a/b/c"],
    [10, "/a/b/c", "/a/b/c"],
    [1, "/a/b/", "/a"],
    [2, "/a/b/", "/a/b"],
    [3, "/a/b/", "/a/b/"],
    [3, "/a//b", "/a//b"],
    [2, "/a//b", "/a/"],
    [1, "//a", "/"],
    [1, "/é/ü", "/é"],
    [10, "/1/2/3/4/5/6/7/8/9/10/11/12", "/1/2/3/4/5/6/7/8/9/10"],
  ])("segments %i on %s gives %s", (segments, path, expected) => {
    expect(coarsened(segments, path)).toBe(expected);
  });

  it("changes only the path: the domain and the rest stay", () => {
    const rules = compile([
      rule(1, { then: [{ action: "coarsen", segments: 1 }, { action: "allow" }] }),
    ]);
    const result = allowed(evaluate(at("/a/b"), rules, "deny", EXT));
    expect(result.event.data).toMatchObject({ domain: "github.com", transition: "link" });
  });

  it("applies to a focus segment's path", () => {
    const rules = compile([
      rule(1, { then: [{ action: "coarsen", segments: 1 }, { action: "allow" }] }),
    ]);
    const result = allowed(evaluate(focusSegment({ path: "/a/b/c" }), rules, "deny", EXT));
    expect(result.event.data).toMatchObject({ path: "/a", durationMs: 300_000 });
  });

  it("two coarsen rules keep the shorter path, whichever order the priorities give", () => {
    for (const [first, second] of [
      [1, 3],
      [3, 1],
    ]) {
      const rules = compile([
        rule(1, { priority: 10, then: [{ action: "coarsen", segments: first }] }),
        rule(2, {
          priority: 20,
          then: [{ action: "coarsen", segments: second }, { action: "allow" }],
        }),
      ]);
      const result = allowed(evaluate(at("/a/b/c/d"), rules, "deny", EXT));
      expect((result.event.data as { path: string }).path).toBe("/a");
    }
  });

  it("leaves events without a path alone", () => {
    const rules = compile([
      rule(1, { then: [{ action: "coarsen", segments: 1 }, { action: "allow" }] }),
    ]);
    const result = allowed(evaluate(tabOpened(), rules, "deny", EXT));
    expect(result.event.data).toEqual({ tabRef: "k3j2h1g4f5d6a7b8", domain: "github.com" });
  });
});

describe("action: keep_query", () => {
  const keep = compile([
    rule(1, {
      when: { all: [{ field: "data.domain", op: "eq", value: "github.com" }] },
      then: [{ action: "keep_query" }, { action: "allow" }],
    }),
  ]);

  it("is reported when a rule matches, and changes nothing else", () => {
    const input = pageVisited();
    const result = allowed(evaluate(input, keep, "deny", EXT));
    expect(result.keepQuery).toBe(true);
    expect(result.event).toEqual(allowed(evaluate(input, compile([rule(1)]), "deny", EXT)).event);
  });

  it("is false when no keep_query rule matched", () => {
    expect(allowed(evaluate(on("example.org"), compile([rule(9)]), "deny", EXT)).keepQuery).toBe(
      false,
    );
    expect(allowed(evaluate(on("example.org"), keep, "allow", EXT)).keepQuery).toBe(false);
  });

  it("a keep_query rule on a dropped event reports nothing: there is no result to keep", () => {
    const rules = compile([
      rule(1, { priority: 1, then: [{ action: "drop" }] }),
      rule(2, { priority: 2, then: [{ action: "keep_query" }] }),
    ]);
    const result = evaluate(pageVisited(), rules, "allow", EXT);
    expect(result.decision).toBe("drop");
    expect(result).not.toHaveProperty("keepQuery");
  });
});

describe("action: tag", () => {
  const tagRule = (n: number, tag: string, extra: Record<string, unknown> = {}) =>
    rule(n, { stage: "process", then: [{ action: "tag", tag }], ...extra });
  const base = rule(100);

  it("adds the tag to a matching event, and none to others", () => {
    const rules = compile([
      base,
      tagRule(1, "work", {
        when: { all: [{ field: "data.domain", op: "eq", value: "github.com" }] },
      }),
    ]);
    expect(allowed(evaluate(pageVisited(), rules, "deny", EXT)).tags).toEqual(["work"]);
    expect(allowed(evaluate(on("example.org"), rules, "deny", EXT)).tags).toEqual([]);
  });

  it("lists each tag once, in rule order", () => {
    const rules = compile([
      base,
      tagRule(1, "b", { priority: 10 }),
      tagRule(2, "a", { priority: 20 }),
      tagRule(3, "b", { priority: 30 }),
      tagRule(4, "c", { priority: 40 }),
    ]);
    expect(allowed(evaluate(pageVisited(), rules, "deny", EXT)).tags).toEqual(["b", "a", "c"]);
  });

  it.each([["a"], ["0"], ["work:project-1"], ["a.b_c"], ["x".repeat(32)]])(
    "accepts the tag %s",
    (tag) => {
      const rules = compile([base, tagRule(1, tag)]);
      expect(allowed(evaluate(pageVisited(), rules, "deny", EXT)).tags).toEqual([tag]);
    },
  );

  it("tags are process-stage only: the extension (process false) adds none", () => {
    const rules = compile([base, tagRule(1, "work")]);
    expect(
      allowed(evaluate(pageVisited(), rules, "deny", { ...EXT, process: false })).tags,
    ).toEqual([]);
  });

  it("a process rule cannot decide, so tags never rescue an event the policy denies", () => {
    const rules = compile([tagRule(1, "work")]);
    expect(evaluate(pageVisited(), rules, "deny", EXT).decision).toBe("drop");
  });

  it("the trace lists the tagging rule and its action name, not the tag", () => {
    const rules = compile([base, tagRule(1, "secret-project")]);
    const trace = allowed(evaluate(pageVisited(), rules, "deny", EXT)).trace;
    expect(trace.matched.at(-1)).toEqual({ ruleId: ruleId(1), actions: ["tag"] });
    expect(JSON.stringify(trace)).not.toContain("secret-project");
  });
});

describe("action: set_retention", () => {
  const retention = (n: number, days: number, extra: Record<string, unknown> = {}) =>
    rule(n, { stage: "process", then: [{ action: "set_retention", days }], ...extra });
  const base = rule(100);

  it("is null when no rule matched", () => {
    expect(allowed(evaluate(pageVisited(), compile([base]), "deny", EXT)).retentionDays).toBeNull();
  });

  it.each([
    [[30], 30],
    [[1], 1],
    [[3650], 3650],
    [[30, 7], 7],
    [[7, 30], 7],
    [[365, 30, 90], 30],
    [[10, 10], 10],
  ])("rules %j give %i days (the smallest wins)", (days, expected) => {
    const rules = compile([base, ...days.map((d, i) => retention(i + 1, d))]);
    expect(allowed(evaluate(pageVisited(), rules, "deny", EXT)).retentionDays).toBe(expected);
  });

  it("only matching rules count", () => {
    const rules = compile([
      base,
      retention(1, 1, {
        when: { all: [{ field: "data.domain", op: "eq", value: "example.org" }] },
      }),
      retention(2, 90),
    ]);
    expect(allowed(evaluate(pageVisited(), rules, "deny", EXT)).retentionDays).toBe(90);
  });

  it("does not run in the extension", () => {
    const rules = compile([base, retention(1, 5)]);
    const result = allowed(evaluate(pageVisited(), rules, "deny", { ...EXT, process: false }));
    expect(result.retentionDays).toBeNull();
  });

  it("tag and set_retention in one rule both apply", () => {
    const rules = compile([
      base,
      rule(1, {
        stage: "process",
        then: [
          { action: "tag", tag: "short" },
          { action: "set_retention", days: 3 },
        ],
      }),
    ]);
    const result = allowed(evaluate(pageVisited(), rules, "deny", EXT));
    expect(result).toMatchObject({ tags: ["short"], retentionDays: 3 });
  });
});

describe("actions together: the plan's example set", () => {
  const rules = compile([
    rule(1, {
      name: "Never settings",
      priority: 1,
      when: { all: [{ field: "data.path", op: "starts_with", value: "/settings" }] },
      then: [{ action: "drop" }],
    }),
    rule(2, {
      name: "GitHub",
      priority: 10,
      when: {
        source: ["browser-extension"],
        type: ["browser.*"],
        all: [{ field: "data.domain", op: "domain_matches", value: "github.com" }],
      },
      then: [{ action: "coarsen", segments: 2 }, { action: "allow" }],
    }),
    rule(3, {
      name: "Tag GitHub",
      stage: "process",
      when: { all: [{ field: "data.domain", op: "eq", value: "github.com" }] },
      then: [
        { action: "tag", tag: "dev" },
        { action: "set_retention", days: 30 },
      ],
    }),
  ]);

  it("a GitHub repo page is collected, coarsened, tagged and given a retention", () => {
    const result = allowed(evaluate(at("/Mohaned178/IdentiK/issues/4"), rules, "deny", EXT));
    expect(result.event.data).toMatchObject({ path: "/Mohaned178/IdentiK" });
    expect(result).toMatchObject({ tags: ["dev"], retentionDays: 30 });
    expect(result.trace).toEqual({
      ruleSetVersion: 7,
      matched: [
        { ruleId: ruleId(2), actions: ["coarsen", "allow"] },
        { ruleId: ruleId(3), actions: ["tag", "set_retention"] },
      ],
      decidedBy: ruleId(2),
    });
  });

  it("a settings page is dropped by the higher-priority rule", () => {
    const result = evaluate(at("/settings/keys"), rules, "deny", EXT);
    expect(result).toEqual({
      decision: "drop",
      trace: {
        ruleSetVersion: 7,
        matched: [{ ruleId: ruleId(1), actions: ["drop"] }],
        decidedBy: ruleId(1),
      },
    });
  });

  it("any other site falls to the default policy", () => {
    expect(evaluate(on("example.org"), rules, "deny", EXT).decision).toBe("drop");
    expect(allowed(evaluate(on("example.org"), rules, "allow", EXT)).tags).toEqual([]);
  });
});
