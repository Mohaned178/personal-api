/**
 * `context.collected` (M4-05, `docs/rule-format.md` open item 1): the extension already ran this
 * rule-set version's collect stage on the event. The server then lets through an event that no
 * collect rule decides, instead of asking the default policy, which would drop an event whose
 * own rule rewrote the field it reads. A rule that decides still decides, in the same order.
 */
import { CLIENT_DECIDER } from "@personal-api/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluate.js";
import { compile, pageVisited, rule, ruleId, tabOpened } from "./test-helpers.js";
import type { EvaluateContext, EvaluationResult } from "./types.js";

const FULL: EvaluateContext = { source: "browser-extension" };
const COLLECTED: EvaluateContext = { source: "browser-extension", collected: true };

function allowed(result: EvaluationResult) {
  if (result.decision !== "allow") throw new Error(`expected allow, got ${result.decision}`);
  return result;
}

const coarsenWork = rule(1, {
  priority: 10,
  when: { all: [{ field: "data.path", op: "starts_with", value: "/work/" }] },
  then: [{ action: "coarsen", segments: 1 }, { action: "allow" }],
});

describe("evaluate: collected (the extension already ran the collect stage)", () => {
  it("lets an event through that its own rewriting rule no longer matches", () => {
    const rules = compile([coarsenWork]);
    const first = allowed(
      evaluate(pageVisited({ path: "/work/projectA/doc" }), rules, "deny", FULL),
    );
    expect(first.event.data).toMatchObject({ path: "/work" });
    expect(evaluate(first.event, rules, "deny", FULL).decision).toBe("drop");

    const again = allowed(evaluate(first.event, rules, "deny", COLLECTED));
    expect(again.event.data).toMatchObject({ path: "/work" });
    expect(again.trace).toEqual({ ruleSetVersion: 7, matched: [], decidedBy: CLIENT_DECIDER });
  });

  it("does not ask the default policy: deny with no rules still lets the event through", () => {
    const result = allowed(evaluate(pageVisited(), compile([]), "deny", COLLECTED));
    expect(result.trace.decidedBy).toBe(CLIENT_DECIDER);
  });

  it("a deciding drop rule still drops, and the result carries no event", () => {
    const rules = compile([
      rule(1, {
        when: { all: [{ field: "data.domain", op: "eq", value: "github.com" }] },
        then: [{ action: "drop" }],
      }),
    ]);
    const result = evaluate(pageVisited(), rules, "allow", COLLECTED);
    expect(result).toEqual({
      decision: "drop",
      trace: {
        ruleSetVersion: 7,
        matched: [{ ruleId: ruleId(1), actions: ["drop"] }],
        decidedBy: ruleId(1),
      },
    });
    expect(result).not.toHaveProperty("event");
  });

  it("an allow that matches still decides, ahead of a later drop (first decider wins)", () => {
    const rules = compile([
      rule(1, { priority: 10, then: [{ action: "allow" }] }),
      rule(2, { priority: 20, then: [{ action: "drop" }] }),
    ]);
    const result = allowed(evaluate(pageVisited(), rules, "deny", COLLECTED));
    expect(result.trace.decidedBy).toBe(ruleId(1));
  });

  it("still applies the transforms of matching rules and the process stage", () => {
    const rules = compile([
      rule(1, {
        when: { type: ["browser.page_visited"] },
        then: [{ action: "redact", field: "data.transition" }],
      }),
      rule(2, {
        stage: "process",
        then: [
          { action: "tag", tag: "seen" },
          { action: "set_retention", days: 30 },
        ],
      }),
    ]);
    const result = allowed(evaluate(pageVisited(), rules, "deny", COLLECTED));
    expect(result.event.data).not.toHaveProperty("transition");
    expect(result.tags).toEqual(["seen"]);
    expect(result.retentionDays).toBe(30);
    expect(result.trace.decidedBy).toBe(CLIENT_DECIDER);
  });

  it("still fails closed: a bad event, an unknown source, a bad rule set", () => {
    expect(evaluate({ nonsense: true }, compile([]), "deny", COLLECTED)).toEqual({
      decision: "error",
      reason: "invalid_event",
    });
    expect(
      evaluate(pageVisited(), compile([]), "deny", { source: "email" as never, collected: true }),
    ).toEqual({ decision: "error", reason: "invalid_context" });
    expect(
      evaluate(
        pageVisited(),
        { version: 1, collect: [{}] as never, process: [] },
        "deny",
        COLLECTED,
      ),
    ).toEqual({ decision: "error", reason: "failed" });
  });

  it("is off unless it is exactly true", () => {
    const loose = { source: "browser-extension", collected: "yes" } as unknown as EvaluateContext;
    expect(evaluate(pageVisited(), compile([]), "deny", loose).decision).toBe("drop");
    expect(
      evaluate(pageVisited(), compile([]), "deny", { ...FULL, collected: false }).decision,
    ).toBe("drop");
  });
});

describe("evaluate: collected (properties)", () => {
  const domainArb = fc.constantFrom("github.com", "gist.github.com", "example.org");
  const eventArb = fc.oneof(
    domainArb.map((domain) => pageVisited({ domain })),
    domainArb.map((domain) => tabOpened({ domain })),
  );
  const partsArb = fc.record({
    priority: fc.integer({ min: 0, max: 5 }),
    domain: domainArb,
    action: fc.constantFrom("allow", "drop", "tag"),
  });
  const setArb = fc.array(partsArb, { maxLength: 6 }).map((parts) =>
    parts.map(({ priority, domain, action }, index) =>
      rule(index + 1, {
        priority,
        stage: action === "tag" ? "process" : "collect",
        when: { all: [{ field: "data.domain", op: "eq", value: domain }] },
        then: [action === "tag" ? { action: "tag", tag: "t" } : { action }],
      }),
    ),
  );
  const policyArb = fc.constantFrom("allow", "deny") as fc.Arbitrary<"allow" | "deny">;

  it("agrees with the full evaluation whenever a rule decided it", () => {
    fc.assert(
      fc.property(eventArb, setArb, policyArb, (event, rules, policy) => {
        const set = compile(rules);
        const full = evaluate(event, set, policy, FULL);
        const collected = evaluate(event, set, policy, COLLECTED);
        if (full.decision === "error" || full.trace.decidedBy !== "default_policy") {
          expect(collected).toEqual(full);
        } else {
          // Nothing decided: the full evaluation follows the policy, collected lets it through.
          expect(collected.decision).toBe("allow");
        }
      }),
      { numRuns: 200 },
    );
  });

  it("never allows an event a deciding drop rule would drop", () => {
    fc.assert(
      fc.property(eventArb, setArb, policyArb, (event, rules, policy) => {
        const set = compile(rules);
        const full = evaluate(event, set, policy, FULL);
        const collected = evaluate(event, set, policy, COLLECTED);
        if (full.decision === "drop" && full.trace.decidedBy !== "default_policy") {
          expect(collected.decision).toBe("drop");
        }
      }),
      { numRuns: 200 },
    );
  });
});
