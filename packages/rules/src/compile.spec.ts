import { describe, expect, it } from "vitest";
import { compileRuleSet } from "./compile.js";
import { rule, ruleId } from "./test-helpers.js";

function ids(rules: readonly { id: string }[]): string[] {
  return rules.map((r) => r.id);
}

describe("compileRuleSet: valid sets", () => {
  it("keeps the version and splits enabled rules by stage", () => {
    const result = compileRuleSet({
      version: 7,
      rules: [
        rule(1),
        rule(2, {
          stage: "process",
          when: { type: ["browser.page_visited"] },
          then: [{ action: "tag", tag: "x" }],
        }),
        rule(3, { enabled: false }),
        rule(4, { enabled: false, stage: "process", then: [{ action: "tag", tag: "y" }] }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ruleSet.version).toBe(7);
    expect(ids(result.ruleSet.collect)).toEqual([ruleId(1)]);
    expect(ids(result.ruleSet.process)).toEqual([ruleId(2)]);
  });

  it("accepts an empty set", () => {
    const result = compileRuleSet({ version: 0, rules: [] });
    expect(result.ok && result.ruleSet.collect).toEqual([]);
  });

  it("sorts by priority ascending (lower runs first)", () => {
    const result = compileRuleSet({
      version: 1,
      rules: [rule(1, { priority: 30 }), rule(2, { priority: 10 }), rule(3, { priority: 20 })],
    });
    expect(result.ok && ids(result.ruleSet.collect)).toEqual([ruleId(2), ruleId(3), ruleId(1)]);
  });

  it("puts rules that drop before the others at the same priority, then orders by id", () => {
    const result = compileRuleSet({
      version: 1,
      rules: [
        rule(1, { priority: 5 }),
        rule(2, { priority: 5, then: [{ action: "drop" }] }),
        rule(3, { priority: 5, then: [{ action: "coarsen", segments: 1 }] }),
        rule(4, { priority: 5, then: [{ action: "drop" }] }),
      ],
    });
    expect(result.ok && ids(result.ruleSet.collect)).toEqual([
      ruleId(2),
      ruleId(4),
      ruleId(1),
      ruleId(3),
    ]);
  });

  it("gives the same order whatever order the rules arrive in", () => {
    const rules = [1, 2, 3, 4, 5].map((n) =>
      rule(n, { priority: n % 2 ? 10 : 20, then: [{ action: n === 4 ? "drop" : "allow" }] }),
    );
    const forward = compileRuleSet({ version: 1, rules });
    const reversed = compileRuleSet({ version: 1, rules: [...rules].reverse() });
    expect(forward).toEqual(reversed);
  });

  it("does not mutate its input", () => {
    const input = { version: 1, rules: [rule(2, { priority: 9 }), rule(1, { priority: 1 })] };
    const snapshot = JSON.parse(JSON.stringify(input));
    compileRuleSet(input);
    expect(input).toEqual(snapshot);
  });
});

describe("compileRuleSet: invalid sets fail closed", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "rules"],
    ["an array", []],
    ["a missing version", { rules: [] }],
    ["a missing rules list", { version: 1 }],
    ["an invalid rule", { version: 1, rules: [rule(1), { ...rule(2), priority: -1 }] }],
    ["a rule with an unknown key", { version: 1, rules: [{ ...rule(1), extra: true }] }],
    ["a rule without an id", { version: 1, rules: [{ ...rule(1), id: undefined }] }],
    ["duplicate ids", { version: 1, rules: [rule(1), rule(1, { priority: 3 })] }],
    [
      "a disabled invalid rule (an invalid rule is never skipped)",
      { version: 1, rules: [{ ...rule(1), enabled: false, stage: "nope" }] },
    ],
  ])("rejects %s", (_name, input) => {
    expect(compileRuleSet(input).ok).toBe(false);
  });

  it("reports issues with a path and never the rule's values", () => {
    const sentinel = "secret-sentinel-xyz.example";
    const bad = rule(1, {
      when: { all: [{ field: "data.domain", op: "eq", value: `${sentinel}:80` }] },
    });
    const result = compileRuleSet({ version: 1, rules: [bad] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]?.path.slice(0, 2)).toEqual(["rules", 0]);
    expect(JSON.stringify(result.issues)).not.toContain(sentinel);
  });

  it("does not throw on a hostile input", () => {
    const hostile = {
      get version(): number {
        throw new Error("boom");
      },
      rules: [],
    };
    expect(() => compileRuleSet(hostile)).not.toThrow();
    expect(compileRuleSet(hostile).ok).toBe(false);
  });
});
