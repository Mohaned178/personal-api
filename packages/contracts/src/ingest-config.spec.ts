import { describe, expect, it } from "vitest";
import { ingestConfigResponseSchema } from "./ingest-config.js";

const RULE_ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";
const OTHER_ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6c";
const rule = {
  id: RULE_ID,
  name: "Track GitHub",
  enabled: true,
  priority: 10,
  stage: "collect",
  when: { type: ["browser.*"] },
  then: [{ action: "allow" }],
};
const config = { ruleSetVersion: 3, defaultPolicy: "deny", rules: [rule] };

describe("ingestConfigResponseSchema", () => {
  it("accepts a version, a policy and collect rules", () => {
    expect(ingestConfigResponseSchema.safeParse(config).success).toBe(true);
  });

  it("accepts a user with no rules (version 0)", () => {
    const empty = { ruleSetVersion: 0, defaultPolicy: "deny", rules: [] };
    expect(ingestConfigResponseSchema.safeParse(empty).success).toBe(true);
  });

  it.each([
    ["a missing version", { defaultPolicy: "deny", rules: [] }],
    ["a negative version", { ...config, ruleSetVersion: -1 }],
    ["a missing policy", { ruleSetVersion: 1, rules: [] }],
    ["an unknown policy", { ...config, defaultPolicy: "maybe" }],
    ["an unknown key", { ...config, userId: "u" }],
    ["a rule without an id", { ...config, rules: [{ ...rule, id: undefined }] }],
    ["an invalid rule", { ...config, rules: [{ ...rule, then: [] }] }],
    [
      "a process rule",
      { ...config, rules: [{ ...rule, stage: "process", then: [{ action: "tag", tag: "x" }] }] },
    ],
    ["a duplicate rule id", { ...config, rules: [rule, { ...rule, name: "Again" }] }],
  ])("rejects %s", (_label, body) => {
    expect(ingestConfigResponseSchema.safeParse(body).success).toBe(false);
  });

  it("accepts two rules with different ids", () => {
    const two = { ...config, rules: [rule, { ...rule, id: OTHER_ID }] };
    expect(ingestConfigResponseSchema.safeParse(two).success).toBe(true);
  });
});
