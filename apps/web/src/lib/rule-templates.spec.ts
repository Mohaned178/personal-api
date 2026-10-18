import { ruleDefinitionSchema } from "@personal-api/contracts";
import { describe, expect, it } from "vitest";
import { RULE_TEMPLATES } from "./rule-templates";

describe("rule templates", () => {
  it.each(RULE_TEMPLATES.map((t) => [t.id, t.rule] as const))("%s is a valid rule", (_id, rule) => {
    expect(ruleDefinitionSchema.safeParse(rule).success).toBe(true);
  });

  it("has unique ids and titles", () => {
    expect(new Set(RULE_TEMPLATES.map((t) => t.id)).size).toBe(RULE_TEMPLATES.length);
    expect(new Set(RULE_TEMPLATES.map((t) => t.title)).size).toBe(RULE_TEMPLATES.length);
  });

  it("only the block template drops", () => {
    const dropping = RULE_TEMPLATES.filter((t) => t.rule.then.some((a) => a.action === "drop"));
    expect(dropping.map((t) => t.id)).toEqual(["never-site"]);
  });
});
