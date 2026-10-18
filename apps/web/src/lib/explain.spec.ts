import type { Rule, RuleTrace } from "@personal-api/contracts";
import { describe, expect, it } from "vitest";
import { explainTrace } from "./explain";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const rule = (id: string, name: string): Rule => ({
  id,
  name,
  enabled: true,
  priority: 1,
  stage: "collect",
  when: {},
  then: [{ action: "allow" }],
});
const trace = (over: Partial<RuleTrace> = {}): RuleTrace => ({
  ruleSetVersion: 4,
  matched: [{ ruleId: A, actions: ["allow", "coarsen"] }],
  decidedBy: A,
  ...over,
});

describe("explainTrace", () => {
  it("says there is no record for an event without a trace", () => {
    const out = explainTrace(null, [], 4);
    expect(out.decision).toMatch(/before rules existed/);
    expect(out.matched).toEqual([]);
  });

  it("names the deciding rule and lists what matched", () => {
    const out = explainTrace(trace(), [rule(A, "Track GitHub")], 4);
    expect(out.decision).toContain("“Track GitHub”");
    expect(out.matched).toEqual([
      { ruleId: A, label: "Track GitHub", actions: ["allow", "coarsen"], decided: true },
    ]);
    expect(out.staleNote).toBeNull();
  });

  it("names a deleted rule as such", () => {
    const out = explainTrace(trace(), [rule(B, "Other")], 4);
    expect(out.decision).toContain("A rule that no longer exists");
  });

  it("does not claim a rule is gone when the rules could not be loaded", () => {
    const out = explainTrace(trace(), undefined, undefined);
    expect(out.matched[0]?.label).toBe("A rule");
    expect(out.staleNote).toBeNull();
  });

  it("explains the default policy and the extension as deciders", () => {
    expect(
      explainTrace(trace({ matched: [], decidedBy: "default_policy" }), [], 4).decision,
    ).toMatch(/default policy/);
    expect(explainTrace(trace({ matched: [], decidedBy: "client" }), [], 4).decision).toMatch(
      /extension/,
    );
  });

  it("flags that the rules changed since the event was stored", () => {
    const out = explainTrace(trace({ ruleSetVersion: 2 }), [rule(A, "x")], 5);
    expect(out.staleNote).toMatch(/version 2.*version is 5/);
  });
});
