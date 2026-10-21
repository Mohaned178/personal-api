import { describe, expect, it } from "vitest";
import {
  ALLOW_ALL_PRIORITY,
  allButSensitiveRules,
  chooseSitesRules,
  PRESET_DOMAINS_PER_RULE,
  RULE_PRESET_IDS,
  RULE_PRESETS,
  SENSITIVE_DOMAINS,
  WORK_DOMAINS,
  workSitesRules,
} from "./rule-presets.js";
import { RULE_LIMITS, type RuleDefinition, ruleSaveSchema } from "./rules.js";

const domains = (rule: RuleDefinition) =>
  (rule.when.any ?? []).map((c) => c.value).filter((v) => !String(v).startsWith("*."));

describe("rule presets (M8-02)", () => {
  it("lists every preset id once, in order", () => {
    expect(RULE_PRESETS.map((p) => p.id)).toEqual([...RULE_PRESET_IDS]);
  });

  it.each([
    ["all-but-sensitive", allButSensitiveRules()],
    ["work-sites", workSitesRules()],
    ["choose-sites", chooseSitesRules(["example.com", "news.example.org"]) ?? []],
  ])("every rule of %s passes ruleSaveSchema", (_id, rules) => {
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const parsed = ruleSaveSchema.safeParse(rule);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });

  it("everything-except-sensitive drops every curated domain before one allow-all", () => {
    const rules = allButSensitiveRules();
    const allowAll = rules.at(-1);
    expect(allowAll).toMatchObject({ when: {}, then: [{ action: "allow" }] });
    expect(allowAll?.priority).toBe(ALLOW_ALL_PRIORITY);

    const drops = rules.slice(0, -1);
    for (const drop of drops) {
      expect(drop.then).toEqual([{ action: "drop" }]);
      expect(drop.priority).toBeLessThan(ALLOW_ALL_PRIORITY);
      expect(drop.when.any?.length ?? 0).toBeLessThanOrEqual(RULE_LIMITS.conditionsMax);
    }
    expect(drops.flatMap(domains).sort()).toEqual(Object.values(SENSITIVE_DOMAINS).flat().sort());
  });

  it("covers each domain and its subdomains", () => {
    for (const rule of [...allButSensitiveRules().slice(0, -1), ...workSitesRules()]) {
      const values = (rule.when.any ?? []).map((c) => c.value);
      for (const domain of domains(rule)) expect(values).toContain(`*.${domain}`);
      expect(values).toHaveLength(domains(rule).length * 2);
    }
  });

  it("work sites is one allow rule over the work list", () => {
    const [rule, ...rest] = workSitesRules();
    expect(rest).toEqual([]);
    expect(rule?.then).toEqual([{ action: "allow" }]);
    expect(domains(rule as RuleDefinition)).toEqual([...WORK_DOMAINS]);
  });

  it("choose sites makes one allow rule and drops duplicates", () => {
    const rules = chooseSitesRules(["a.example", "b.example", "a.example"]);
    expect(rules).toHaveLength(1);
    expect(domains((rules as RuleDefinition[])[0] as RuleDefinition)).toEqual([
      "a.example",
      "b.example",
    ]);
  });

  it.each([
    ["no domain", []],
    ["an invalid domain", ["Example.com"]],
    ["a URL", ["https://example.com"]],
    ["a pattern", ["*.example.com"]],
    ["too many", Array.from({ length: PRESET_DOMAINS_PER_RULE + 1 }, (_, i) => `s${i}.example`)],
  ])("choose sites refuses %s", (_label, input) => {
    expect(chooseSitesRules(input)).toBeNull();
  });

  it("choose sites accepts the most one rule can hold", () => {
    const max = Array.from({ length: PRESET_DOMAINS_PER_RULE }, (_, i) => `s${i}.example`);
    const rules = chooseSitesRules(max) ?? [];
    expect(ruleSaveSchema.safeParse(rules[0]).success).toBe(true);
  });
});
