import { allButSensitiveRules, type Rule, workSitesRules } from "@personal-api/contracts";
import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluate.js";
import { compile, focusSegment, pageVisited, ruleId } from "./test-helpers.js";
import type { EvaluateContext } from "./types.js";

// M8-02: the wizard's presets, run through the engine the dry run (`POST /v1/rules/test`), the
// API and the extension share.

const EXT: EvaluateContext = { source: "browser-extension" };
const withIds = (rules: ReturnType<typeof allButSensitiveRules>): Rule[] =>
  rules.map((rule, index) => ({ id: ruleId(index + 1), ...rule }));

describe("preset: everything except sensitive sites", () => {
  const rules = compile(withIds(allButSensitiveRules()));

  it.each(["chase.com", "www.chase.com", "secure.paypal.com", "mail.google.com", "nhs.uk"])(
    "drops %s",
    (domain) => {
      expect(evaluate(pageVisited({ domain }), rules, "deny", EXT).decision).toBe("drop");
      expect(evaluate(focusSegment({ domain }), rules, "deny", EXT).decision).toBe("drop");
    },
  );

  it.each(["github.com", "en.wikipedia.org", "google.com", "notchase.com"])(
    "allows %s under a deny default",
    (domain) => {
      const result = evaluate(pageVisited({ domain }), rules, "deny", EXT);
      expect(result.decision).toBe("allow");
    },
  );

  it("the drop is decided by a preset rule, not the default policy", () => {
    const result = evaluate(pageVisited({ domain: "chase.com" }), rules, "deny", EXT);
    expect(result.decision === "drop" && result.trace.decidedBy).toBe(ruleId(1));
  });
});

describe("preset: only work sites", () => {
  const rules = compile(withIds(workSitesRules()));

  it("allows a work site and drops anything else", () => {
    expect(evaluate(pageVisited({ domain: "github.com" }), rules, "deny", EXT).decision).toBe(
      "allow",
    );
    expect(evaluate(pageVisited({ domain: "example.org" }), rules, "deny", EXT).decision).toBe(
      "drop",
    );
  });
});
