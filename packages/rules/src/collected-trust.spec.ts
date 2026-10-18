/**
 * M4-R S3: `context.collected` is only worth honouring when an `allow` rule reads a field that a
 * collect transform rewrites (`data.path` with any `coarsen`, or a field some `redact` removes).
 * Otherwise a re-evaluation is stable and the default policy must keep deciding (invariant 1).
 */
import type { Rule } from "@personal-api/contracts";
import { describe, expect, it } from "vitest";
import { canTrustCollected } from "./collected-trust.js";
import { evaluate } from "./evaluate.js";
import { compile, pageVisited, rule } from "./test-helpers.js";

const pathCondition = { field: "data.path", op: "starts_with", value: "/work/" } as const;
const domainCondition = { field: "data.domain", op: "eq", value: "github.com" } as const;

const trusted = (rules: Rule[]) => canTrustCollected(compile(rules));

describe("canTrustCollected", () => {
  it("is false for no rules and for rules that rewrite nothing", () => {
    expect(trusted([])).toBe(false);
    expect(trusted([rule(1, { when: { all: [pathCondition] } })])).toBe(false);
  });

  it("is true when a coarsen rewrites the path an allow rule reads", () => {
    expect(
      trusted([
        rule(1, {
          when: { all: [pathCondition] },
          then: [{ action: "coarsen", segments: 1 }, { action: "allow" }],
        }),
      ]),
    ).toBe(true);
  });

  it("is true when the coarsen and the allow are in different rules", () => {
    expect(
      trusted([
        rule(1, { when: { all: [pathCondition] } }),
        rule(2, { when: {}, then: [{ action: "coarsen", segments: 2 }] }),
      ]),
    ).toBe(true);
  });

  it("is true when a redact removes a field an allow rule reads, in all, any or none", () => {
    const redactTransition = rule(9, {
      when: {},
      then: [{ action: "redact", field: "data.transition" }],
    });
    const reads = { field: "data.transition", op: "eq", value: "link" } as const;
    for (const when of [{ all: [reads] }, { any: [reads] }, { none: [reads] }]) {
      expect(trusted([rule(1, { when }), redactTransition])).toBe(true);
    }
  });

  it("is false when the rewritten field is read only by a drop rule", () => {
    expect(
      trusted([
        rule(1, { when: { all: [pathCondition] }, then: [{ action: "drop" }] }),
        rule(2, { when: {}, then: [{ action: "coarsen", segments: 1 }] }),
        rule(3, { when: { all: [domainCondition] } }),
      ]),
    ).toBe(false);
  });

  it("is false when an allow rule reads a field nothing rewrites", () => {
    expect(
      trusted([
        rule(1, { when: { all: [domainCondition] } }),
        rule(2, { when: {}, then: [{ action: "coarsen", segments: 1 }] }),
        rule(3, { when: {}, then: [{ action: "redact", field: "data.transition" }] }),
      ]),
    ).toBe(false);
  });

  it("ignores disabled rules, which the compiled set leaves out", () => {
    expect(
      trusted([
        rule(1, { when: { all: [pathCondition] } }),
        rule(2, { enabled: false, when: {}, then: [{ action: "coarsen", segments: 1 }] }),
      ]),
    ).toBe(false);
  });

  it("ignores process-stage rules, which never rewrite the event", () => {
    expect(
      trusted([
        rule(1, { when: { all: [pathCondition] } }),
        rule(2, { stage: "process", when: {}, then: [{ action: "tag", tag: "x" }] }),
      ]),
    ).toBe(false);
  });

  it("is computed once per compiled set", () => {
    const set = compile([rule(1, { when: { all: [pathCondition] } })]);
    expect(canTrustCollected(set)).toBe(canTrustCollected(set));
  });

  it("agrees with what evaluating the rewritten event again does", () => {
    // The two sides of the precondition: with it, the rewritten event is no longer decided by its
    // own rule; without it, evaluating again gives the same allow, so no shortcut is needed.
    const rewriting = compile([
      rule(1, {
        when: { all: [pathCondition] },
        then: [{ action: "coarsen", segments: 1 }, { action: "allow" }],
      }),
    ]);
    const plain = compile([rule(1, { when: { all: [domainCondition] } })]);
    const ctx = { source: "browser-extension" } as const;
    for (const [set, expected] of [
      [rewriting, true],
      [plain, false],
    ] as const) {
      const first = evaluate(pageVisited({ path: "/work/a/b" }), set, "deny", ctx);
      if (first.decision !== "allow") throw new Error("expected allow");
      const again = evaluate(first.event, set, "deny", ctx);
      expect(again.decision === "drop").toBe(expected);
      expect(canTrustCollected(set)).toBe(expected);
    }
  });
});
