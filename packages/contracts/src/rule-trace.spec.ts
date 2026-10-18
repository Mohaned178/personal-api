import { describe, expect, it } from "vitest";
import { DEFAULT_POLICIES } from "./integrations.js";
import { CLIENT_DECIDER, DEFAULT_POLICY_DECIDER, ruleTraceSchema } from "./rule-trace.js";
import { RULE_ACTION_NAMES, ruleActionSchema, ruleSetSchema } from "./rules.js";

const RULE_ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";

describe("ruleTraceSchema", () => {
  it("accepts a trace decided by a rule", () => {
    const trace = {
      ruleSetVersion: 7,
      matched: [{ ruleId: RULE_ID, actions: ["allow", "coarsen"] }],
      decidedBy: RULE_ID,
    };
    expect(ruleTraceSchema.parse(trace)).toEqual(trace);
  });

  it("accepts a trace decided by the default policy, with nothing matched", () => {
    const trace = { ruleSetVersion: 0, matched: [], decidedBy: DEFAULT_POLICY_DECIDER };
    expect(ruleTraceSchema.parse(trace)).toEqual(trace);
  });

  it("accepts a trace decided by the client (its collect stage already ran, M4-05)", () => {
    const trace = { ruleSetVersion: 3, matched: [], decidedBy: CLIENT_DECIDER };
    expect(CLIENT_DECIDER).toBe("client");
    expect(ruleTraceSchema.parse(trace)).toEqual(trace);
  });

  it.each([
    ["an unknown key", { ruleSetVersion: 1, matched: [], decidedBy: "default_policy", extra: 1 }],
    ["a negative version", { ruleSetVersion: -1, matched: [], decidedBy: "default_policy" }],
    ["a fractional version", { ruleSetVersion: 1.5, matched: [], decidedBy: "default_policy" }],
    ["a missing decidedBy", { ruleSetVersion: 1, matched: [] }],
    ["a decidedBy that is not an id", { ruleSetVersion: 1, matched: [], decidedBy: "somebody" }],
    [
      "an unknown action name",
      {
        ruleSetVersion: 1,
        matched: [{ ruleId: RULE_ID, actions: ["exfiltrate"] }],
        decidedBy: RULE_ID,
      },
    ],
    [
      "action params (a trace holds names only, never values)",
      {
        ruleSetVersion: 1,
        matched: [{ ruleId: RULE_ID, actions: [{ action: "tag", tag: "work" }] }],
        decidedBy: RULE_ID,
      },
    ],
    [
      "a matched entry that is not a rule id",
      { ruleSetVersion: 1, matched: [{ ruleId: "x", actions: ["allow"] }], decidedBy: RULE_ID },
    ],
    [
      "a matched entry with an unknown key",
      {
        ruleSetVersion: 1,
        matched: [{ ruleId: RULE_ID, actions: ["allow"], domain: "a.com" }],
        decidedBy: RULE_ID,
      },
    ],
  ])("rejects %s", (_name, trace) => {
    expect(ruleTraceSchema.safeParse(trace).success).toBe(false);
  });
});

describe("shared rule constants", () => {
  it("RULE_ACTION_NAMES lists exactly the actions in ruleActionSchema", () => {
    const names = ruleActionSchema.options.map((option) => option.shape.action.value);
    expect([...names].sort()).toEqual([...RULE_ACTION_NAMES].sort());
  });

  it("DEFAULT_POLICIES is deny and allow, and deny comes first", () => {
    expect(DEFAULT_POLICIES).toEqual(["deny", "allow"]);
  });
});

describe("ruleSetSchema", () => {
  const rule = (id: string) => ({
    id,
    name: "Track GitHub",
    enabled: true,
    priority: 10,
    stage: "collect",
    when: { all: [{ field: "data.domain", op: "domain_matches", value: "github.com" }] },
    then: [{ action: "allow" }],
  });
  const OTHER_ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6c";

  it("accepts a version with rules, or with none", () => {
    expect(
      ruleSetSchema.safeParse({ version: 3, rules: [rule(RULE_ID), rule(OTHER_ID)] }).success,
    ).toBe(true);
    expect(ruleSetSchema.safeParse({ version: 0, rules: [] }).success).toBe(true);
  });

  it.each([
    ["a missing version", { rules: [] }],
    ["a negative version", { version: -1, rules: [] }],
    ["missing rules", { version: 1 }],
    ["an unknown key", { version: 1, rules: [], extra: 1 }],
    ["an invalid rule", { version: 1, rules: [{ ...rule(RULE_ID), extra: 1 }] }],
    ["a rule without an id", { version: 1, rules: [{ ...rule(RULE_ID), id: undefined }] }],
    ["two rules with the same id", { version: 1, rules: [rule(RULE_ID), rule(RULE_ID)] }],
    ["null", null],
  ])("rejects %s", (_name, input) => {
    expect(ruleSetSchema.safeParse(input).success).toBe(false);
  });

  it("points at the duplicate rule", () => {
    const result = ruleSetSchema.safeParse({ version: 1, rules: [rule(RULE_ID), rule(RULE_ID)] });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map((i) => i.path.join("."))).toEqual(["rules.1.id"]);
  });
});
