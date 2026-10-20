import { describe, expect, it } from "vitest";
import {
  RULES_PER_USER_MAX,
  ruleResponseSchema,
  testRuleRequestSchema,
  testRuleResponseSchema,
} from "./rules-api.js";

const RULE_ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";
const rule = {
  name: "Track GitHub",
  enabled: true,
  priority: 10,
  stage: "collect",
  when: { type: ["browser.*"] },
  then: [{ action: "allow" }],
};
const event = {
  id: "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b",
  type: "browser.tab_opened",
  typeVersion: 1,
  occurredAt: "2026-10-14T12:00:00.000Z",
  data: { tabRef: "tab-ref-12345678" },
};
const base = { event, source: "browser-extension" };

describe("testRuleRequestSchema", () => {
  it("defaults the policy to deny (invariant 1)", () => {
    expect(testRuleRequestSchema.parse(base).defaultPolicy).toBe("deny");
  });

  it("accepts a draft alone, a replacement and an only-draft", () => {
    expect(testRuleRequestSchema.safeParse({ ...base, rule }).success).toBe(true);
    expect(testRuleRequestSchema.safeParse({ ...base, rule, replaceRuleId: RULE_ID }).success).toBe(
      true,
    );
    expect(testRuleRequestSchema.safeParse({ ...base, rule, onlyRule: true }).success).toBe(true);
  });

  it.each([
    ["replaceRuleId without a draft", { ...base, replaceRuleId: RULE_ID }],
    ["onlyRule without a draft", { ...base, onlyRule: true }],
    [
      "replaceRuleId together with onlyRule",
      { ...base, rule, replaceRuleId: RULE_ID, onlyRule: true },
    ],
    ["an invalid draft", { ...base, rule: { ...rule, priority: -1 } }],
    [
      "a draft with the reserved keep_query action",
      { ...base, rule: { ...rule, then: [{ action: "allow" }, { action: "keep_query" }] } },
    ],
    ["an unknown key", { ...base, userId: "someone" }],
    ["an unknown source", { ...base, source: "mobile" }],
    ["a non-object event", { ...base, event: "page" }],
    ["a missing event", { source: "http" }],
  ])("rejects %s", (_label, input) => {
    expect(testRuleRequestSchema.safeParse(input).success).toBe(false);
  });
});

describe("responses", () => {
  it("a rule response carries the rule with its id and the version", () => {
    const body = { rule: { id: RULE_ID, ...rule }, version: 3 };
    expect(ruleResponseSchema.parse(body)).toEqual(body);
    expect(ruleResponseSchema.safeParse({ ...body, userId: "x" }).success).toBe(false);
  });

  it("a dropped result has a trace and no event", () => {
    const trace = { ruleSetVersion: 1, matched: [], decidedBy: "default_policy" };
    expect(testRuleResponseSchema.safeParse({ decision: "drop", trace }).success).toBe(true);
    expect(testRuleResponseSchema.safeParse({ decision: "drop", trace, event }).success).toBe(
      false,
    );
  });

  it("caps the rules per user at 100", () => {
    expect(RULES_PER_USER_MAX).toBe(100);
  });
});
