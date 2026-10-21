import { ruleDefinitionSchema } from "@personal-api/contracts";
import { describe, expect, it } from "vitest";
import { dropTemplateFromHash, neverCollectRule, RULE_TEMPLATES } from "./rule-templates";

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

  it("the block template covers the apex and its subdomains (M4-R nit)", () => {
    // `domain_matches` on `*.example.com` does not match `example.com` itself (rule-format.md).
    const never = RULE_TEMPLATES.find((t) => t.id === "never-site");
    const values = (never?.rule.when.any ?? []).map((c) => c.value);
    expect(values).toEqual(["example.com", "*.example.com"]);
    expect(never?.rule.when.all).toBeUndefined();
  });

  it("the drop rule for a domain is valid and covers its subdomains (M8-04)", () => {
    const rule = neverCollectRule("github.com");
    expect(ruleDefinitionSchema.safeParse(rule).success).toBe(true);
    expect(rule.when.any?.map((c) => c.value)).toEqual(["github.com", "*.github.com"]);
  });

  it("reads #drop=<domain> and refuses anything that is not a domain (M8-04)", () => {
    expect(dropTemplateFromHash("#drop=github.com")?.rule).toEqual(neverCollectRule("github.com"));
    expect(dropTemplateFromHash("drop=github.com")?.rule.name).toBe("Never collect github.com");
    for (const hash of [
      "",
      "#",
      "#drop=",
      "#drop=GitHub.com",
      "#drop=a.com/x",
      "#drop=//evil",
      "#other=a.com",
    ]) {
      expect(dropTemplateFromHash(hash)).toBeNull();
    }
  });
});
