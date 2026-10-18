/**
 * Property tests (M4-03): fast-check over generated events and rule sets. The tables in
 * `evaluate.tables.spec.ts` say what each op and action does; these say what must hold for *any*
 * input. Generators build valid rules by construction and go through `compile`, which throws on
 * an invalid set, so a bug in a generator shows up as a failure rather than as a skipped case.
 *
 * What "idempotent" means here (open item 1 in docs/rule-format.md):
 *  - the transforms are idempotent without conditions: applying them twice equals once;
 *  - the evaluated *event* is stable when it is evaluated again, **only** for rule sets whose
 *    conditions read fields that no rule rewrites (the "domain-only" generator). It is not claimed
 *    in general, because a rule can stop matching its own output, so the *decision* is not stable
 *    either (`evaluate.spec.ts` pins that known limitation).
 */
import {
  INTEGRATION_KINDS,
  parseEvent,
  RULE_ACTION_NAMES,
  type Rule,
  ruleSetSchema,
  ruleTraceSchema,
} from "@personal-api/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compileRuleSet } from "./compile.js";
import { evaluate } from "./evaluate.js";
import { compile, focusSegment, pageVisited, rule, ruleId, tabOpened } from "./test-helpers.js";
import { applyTransform, coarsenPath, type TransformState } from "./transforms.js";
import type { DefaultPolicy, EvaluateContext, EvaluationResult } from "./types.js";

const RUNS = { numRuns: 200 };

// ---------------------------------------------------------------------------------------------
// Generators

const DOMAIN_POOL = ["github.com", "gist.github.com", "a.b.example.org", "example.org"] as const;
const PATH_POOL = [
  "/",
  "/a",
  "/a/b",
  "/a/b/c/d",
  "/work/projectA/doc",
  "/settings/profile",
  "/Mohaned178/IdentiK",
] as const;

const labelArb = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/);
const tldArb = fc.stringMatching(/^[a-z]{2,6}$/);
const randomDomainArb = fc
  .tuple(fc.array(labelArb, { minLength: 1, maxLength: 3 }), tldArb)
  .map(([labels, tld]) => [...labels, tld].join("."));
const segmentArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,11}$/);
const randomPathArb = fc
  .array(segmentArb, { minLength: 0, maxLength: 6 })
  .map((segments) => `/${segments.join("/")}`);

// Mostly from small pools so rules actually match, sometimes anything legal.
const domainArb = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...DOMAIN_POOL) },
  { weight: 1, arbitrary: randomDomainArb },
);
const pathArb = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...PATH_POOL) },
  { weight: 1, arbitrary: randomPathArb },
);

const eventArb = fc.oneof(
  fc
    .record({
      domain: domainArb,
      path: pathArb,
      transition: fc.constantFrom("link", "typed", "reload", undefined),
    })
    .map((data) => dropUndefinedData(pageVisited(data))),
  fc.record({ domain: domainArb, path: pathArb }).map((data) => focusSegment(data)),
  fc
    .option(domainArb, { nil: undefined })
    .map((domain) => dropUndefinedData(tabOpened({ domain }))),
);

function dropUndefinedData(event: Record<string, unknown>): Record<string, unknown> {
  const data = Object.fromEntries(
    Object.entries(event.data as Record<string, unknown>).filter(([, v]) => v !== undefined),
  );
  return { ...event, data };
}

const domainConditionArb = fc.oneof(
  fc.record({ field: fc.constant("data.domain"), op: fc.constant("eq"), value: domainArb }),
  fc.record({ field: fc.constant("data.domain"), op: fc.constant("neq"), value: domainArb }),
  fc.record({
    field: fc.constant("data.domain"),
    op: fc.constant("in"),
    value: fc.uniqueArray(domainArb, { minLength: 1, maxLength: 3 }),
  }),
  fc.record({
    field: fc.constant("data.domain"),
    op: fc.constantFrom("starts_with", "ends_with", "contains"),
    value: fc.constantFrom("git", "gist.", "example", "a.", ".com", ".org", "hub"),
  }),
  fc.record({
    field: fc.constant("data.domain"),
    op: fc.constant("domain_matches"),
    value: fc.constantFrom("github.com", "*.github.com", "example.org", "*.example.org"),
  }),
  fc.record({
    field: fc.constant("data.domain"),
    op: fc.constant("matches_glob"),
    value: fc.constantFrom("*.com", "git*", "*example*", "*"),
  }),
  fc.record({ field: fc.constant("data.domain"), op: fc.constant("exists"), value: fc.boolean() }),
);

const pathConditionArb = fc.oneof(
  fc.record({ field: fc.constant("data.path"), op: fc.constant("eq"), value: pathArb }),
  fc.record({ field: fc.constant("data.path"), op: fc.constant("neq"), value: pathArb }),
  fc.record({
    field: fc.constant("data.path"),
    op: fc.constant("in"),
    value: fc.uniqueArray(pathArb, { minLength: 1, maxLength: 3 }),
  }),
  fc.record({
    field: fc.constant("data.path"),
    op: fc.constantFrom("starts_with", "ends_with", "contains"),
    value: fc.constantFrom("/", "/a", "/work/", "/settings", "IdentiK", "b", "doc"),
  }),
  fc.record({
    field: fc.constant("data.path"),
    op: fc.constant("matches_glob"),
    value: fc.constantFrom("/*", "/a/*", "*settings*", "/work/*/doc", "*"),
  }),
  fc.record({ field: fc.constant("data.path"), op: fc.constant("exists"), value: fc.boolean() }),
);

const anyConditionArb = fc.oneof(domainConditionArb, pathConditionArb);

function whenArb(conditions: fc.Arbitrary<unknown>) {
  const list = fc.array(conditions, { minLength: 1, maxLength: 3 });
  return fc.record(
    {
      source: fc.constantFrom(["browser-extension"], ["http"], ["browser-extension", "http"]),
      type: fc.constantFrom(
        ["browser.*"],
        ["browser.page_visited"],
        ["browser.tab_*", "browser.page_visited"],
      ),
      all: list,
      any: list,
      none: list,
    },
    { requiredKeys: [] },
  );
}

interface RuleSetOptions {
  /** Which deciding actions collect rules may use (`undefined`: a rule that only transforms). */
  deciders?: readonly ("allow" | "drop" | undefined)[];
  /** Conditions may read only `data.domain`, which no rule rewrites. */
  domainOnly?: boolean;
  /** Collect rules may be anywhere from 0 to this many. */
  maxCollect?: number;
}

function collectRuleArb(options: RuleSetOptions) {
  const conditions = options.domainOnly ? domainConditionArb : anyConditionArb;
  return fc
    .record({
      priority: fc.integer({ min: 0, max: 20 }),
      enabled: fc.constantFrom(true, true, true, false),
      when: whenArb(conditions),
      decider: fc.constantFrom(...(options.deciders ?? (["allow", "drop", undefined] as const))),
      coarsen: fc.option(fc.integer({ min: 0, max: 4 }), { nil: undefined }),
      redact: fc.boolean(),
      keepQuery: fc.boolean(),
    })
    .map(({ decider, coarsen, redact, keepQuery, ...rest }) => {
      const then: Record<string, unknown>[] = [];
      if (decider !== undefined) then.push({ action: decider });
      if (coarsen !== undefined) then.push({ action: "coarsen", segments: coarsen });
      if (redact) then.push({ action: "redact", field: "data.transition" });
      if (keepQuery) then.push({ action: "keep_query" });
      if (then.length === 0) then.push({ action: "keep_query" });
      return { ...rest, stage: "collect", then };
    });
}

function processRuleArb(options: RuleSetOptions) {
  const conditions = options.domainOnly ? domainConditionArb : anyConditionArb;
  return fc
    .record({
      priority: fc.integer({ min: 0, max: 20 }),
      enabled: fc.constantFrom(true, true, true, false),
      when: whenArb(conditions),
      tag: fc.option(fc.constantFrom("a", "b", "work", "x:y"), { nil: undefined }),
      days: fc.option(fc.constantFrom(1, 7, 30, 365), { nil: undefined }),
    })
    .map(({ tag, days, ...rest }) => {
      const then: Record<string, unknown>[] = [];
      if (tag !== undefined) then.push({ action: "tag", tag });
      if (days !== undefined) then.push({ action: "set_retention", days });
      if (then.length === 0) then.push({ action: "tag", tag: "t" });
      return { ...rest, stage: "process", then };
    });
}

/** A valid rule list with distinct ids. */
function rulesArb(options: RuleSetOptions = {}): fc.Arbitrary<Rule[]> {
  return fc
    .tuple(
      fc.array(collectRuleArb(options), { maxLength: options.maxCollect ?? 6 }),
      fc.array(processRuleArb(options), { maxLength: 3 }),
    )
    .map(([collect, process]) =>
      [...collect, ...process].map((overrides, i) => rule(i + 1, overrides)),
    );
}

const policyArb: fc.Arbitrary<DefaultPolicy> = fc.constantFrom("allow", "deny");
const contextArb: fc.Arbitrary<EvaluateContext> = fc.record({
  source: fc.constantFrom(...INTEGRATION_KINDS),
  process: fc.boolean(),
});
const versionArb = fc.integer({ min: 1, max: 50 });

function allowed(result: EvaluationResult) {
  if (result.decision !== "allow") throw new Error(`expected allow, got ${result.decision}`);
  return result;
}

// ---------------------------------------------------------------------------------------------

describe("generators produce what they claim", () => {
  it("events are valid and rule sets compile", () => {
    fc.assert(
      fc.property(eventArb, rulesArb(), versionArb, (event, rules, version) => {
        expect(parseEvent(event).ok, JSON.stringify(event)).toBe(true);
        expect(compileRuleSet({ version, rules }).ok).toBe(true);
      }),
      RUNS,
    );
  });
});

describe("determinism", () => {
  it("the same input gives the same result, and nothing is mutated", () => {
    fc.assert(
      fc.property(eventArb, rulesArb(), policyArb, contextArb, (event, rules, policy, ctx) => {
        const set = compile(rules);
        const eventBefore = JSON.stringify(event);
        const setBefore = JSON.stringify(set);
        const first = evaluate(event, set, policy, ctx);
        const second = evaluate(event, set, policy, ctx);
        expect(second).toEqual(first);
        expect(JSON.stringify(event)).toBe(eventBefore);
        expect(JSON.stringify(set)).toBe(setBefore);
        expect(compile(rules)).toEqual(set);
      }),
      RUNS,
    );
  });

  it("does not depend on the order the rules arrive in", () => {
    const shuffled = rulesArb().chain((rules) =>
      fc.tuple(
        fc.constant(rules),
        fc.shuffledSubarray(rules, { minLength: rules.length, maxLength: rules.length }),
      ),
    );
    fc.assert(
      fc.property(
        eventArb,
        shuffled,
        policyArb,
        contextArb,
        (event, [rules, other], policy, ctx) => {
          expect(evaluate(event, compile(other), policy, ctx)).toEqual(
            evaluate(event, compile(rules), policy, ctx),
          );
        },
      ),
      RUNS,
    );
  });
});

describe("priority and drop dominance", () => {
  it("the first deciding rule wins: lowest priority, then drop, then id", () => {
    const decidersArb = fc.array(
      fc.record({
        priority: fc.integer({ min: 0, max: 10 }),
        action: fc.constantFrom("allow", "drop"),
      }),
      { minLength: 1, maxLength: 8 },
    );
    fc.assert(
      fc.property(eventArb, decidersArb, policyArb, (event, deciders, policy) => {
        const rules = deciders.map((d, i) =>
          rule(i + 1, { priority: d.priority, then: [{ action: d.action }] }),
        );
        // An independent oracle: no conditions, so every rule matches every event.
        const winner = [...rules].sort((a, b) => {
          const byPriority = a.priority - b.priority;
          if (byPriority !== 0) return byPriority;
          const aDrop = a.then[0]?.action === "drop";
          const bDrop = b.then[0]?.action === "drop";
          if (aDrop !== bDrop) return aDrop ? -1 : 1;
          return a.id < b.id ? -1 : 1;
        })[0] as Rule;
        const result = evaluate(event, compile(rules), policy, { source: "browser-extension" });
        expect(result.decision).toBe(winner.then[0]?.action);
        if (result.decision !== "error") expect(result.trace.decidedBy).toBe(winner.id);
      }),
      RUNS,
    );
  });

  it("drop dominance: a matching drop rule that nothing outranks always drops", () => {
    fc.assert(
      fc.property(
        eventArb,
        rulesArb(),
        policyArb,
        contextArb,
        fc.integer({ min: 0, max: 20 }),
        fc.boolean(),
        (event, rules, policy, ctx, priority, targeted) => {
          const type = (event as { type: string }).type;
          const dropRule = rule(99, {
            priority,
            when: targeted ? { type: [type], source: [ctx.source] } : {},
            then: [{ action: "drop" }],
          });
          // Every other collect rule has the same or a larger priority number (runs no earlier).
          const others = rules.map((r) =>
            r.stage === "collect"
              ? ({ ...r, priority: Math.max(priority, r.priority) } as Rule)
              : r,
          );
          const result = evaluate(event, compile([...others, dropRule]), policy, ctx);
          expect(result.decision).toBe("drop");
          expect(result).not.toHaveProperty("event");
        },
      ),
      RUNS,
    );
  });

  it("transform-only rules never change the decision: conditions see the incoming event", () => {
    fc.assert(
      fc.property(eventArb, rulesArb(), policyArb, contextArb, (event, rules, policy, ctx) => {
        const rewriter = rule(99, {
          priority: 0,
          then: [
            { action: "coarsen", segments: 0 },
            { action: "redact", field: "data.transition" },
          ],
          when: { type: ["browser.page_visited"] },
        });
        const plain = evaluate(event, compile(rules), policy, ctx);
        const rewritten = evaluate(event, compile([...rules, rewriter]), policy, ctx);
        expect(rewritten.decision).toBe(plain.decision);
        if (plain.decision !== "error" && rewritten.decision !== "error") {
          expect(rewritten.trace.decidedBy).toBe(plain.trace.decidedBy);
        }
      }),
      RUNS,
    );
  });

  it("adding a drop rule never turns a drop or an error into an allow", () => {
    fc.assert(
      fc.property(eventArb, rulesArb(), policyArb, contextArb, (event, rules, policy, ctx) => {
        const before = evaluate(event, compile(rules), policy, ctx);
        const after = evaluate(
          event,
          compile([...rules, rule(99, { priority: 5, then: [{ action: "drop" }] })]),
          policy,
          ctx,
        );
        if (before.decision !== "allow") expect(after.decision).not.toBe("allow");
      }),
      RUNS,
    );
  });
});

describe("deny by default (invariant 1)", () => {
  const nonAllowPolicy = fc.oneof(
    fc.constant("deny"),
    fc.constantFrom("ALLOW", "Allow", " allow", "", null, undefined, 0, 1, true, {}, ["allow"]),
    fc.string().filter((s) => s !== "allow"),
  );

  it("without an allow rule and with a policy that is not exactly `allow`, nothing is collected", () => {
    fc.assert(
      fc.property(
        eventArb,
        rulesArb({ deciders: [undefined, "drop"] }),
        nonAllowPolicy,
        contextArb,
        (event, rules, policy, ctx) => {
          const result = evaluate(event, compile(rules), policy as never, ctx);
          expect(result.decision).toBe("drop");
        },
      ),
      RUNS,
    );
  });

  it("with no rules at all, an event is collected exactly when the policy is `allow`", () => {
    const policyAnything = fc.oneof(fc.constant("allow"), nonAllowPolicy, fc.anything());
    fc.assert(
      fc.property(eventArb, policyAnything, contextArb, (event, policy, ctx) => {
        const result = evaluate(event, compile([]), policy as never, ctx);
        expect(result.decision === "allow").toBe(policy === "allow");
      }),
      RUNS,
    );
  });
});

describe("conditions", () => {
  const holds = (cond: unknown, event: unknown) =>
    evaluate(event, compile([rule(1, { when: { all: [cond] } })]), "deny", {
      source: "browser-extension",
    }).decision === "allow";

  it("all, any and none are the AND, OR and NOR of their conditions", () => {
    const conds = fc.array(anyConditionArb, { minLength: 1, maxLength: 4 });
    fc.assert(
      fc.property(eventArb, conds, (event, list) => {
        const each = list.map((cond) => holds(cond, event));
        const on = (when: Record<string, unknown>) =>
          evaluate(event, compile([rule(1, { when })]), "deny", {
            source: "browser-extension",
          }).decision === "allow";
        expect(on({ all: list })).toBe(each.every(Boolean));
        expect(on({ any: list })).toBe(each.some(Boolean));
        expect(on({ none: list })).toBe(!each.some(Boolean));
      }),
      RUNS,
    );
  });

  it("eq and neq are opposites on a field the event has, and both false on one it lacks", () => {
    fc.assert(
      fc.property(eventArb, domainArb, (event, value) => {
        const hasDomain = Object.hasOwn((event as { data: object }).data, "domain");
        const eq = holds({ field: "data.domain", op: "eq", value }, event);
        const neq = holds({ field: "data.domain", op: "neq", value }, event);
        if (hasDomain) expect(eq).not.toBe(neq);
        else expect([eq, neq]).toEqual([false, false]);
      }),
      RUNS,
    );
  });

  it("exists true and exists false are opposites for every field", () => {
    fc.assert(
      fc.property(
        eventArb,
        fc.constantFrom("data.domain", "data.path", "data.transition"),
        (event, field) => {
          expect(holds({ field, op: "exists", value: true }, event)).not.toBe(
            holds({ field, op: "exists", value: false }, event),
          );
        },
      ),
      RUNS,
    );
  });

  it("`in` is an OR of `eq`", () => {
    fc.assert(
      fc.property(
        eventArb,
        fc.uniqueArray(domainArb, { minLength: 1, maxLength: 4 }),
        (event, values) => {
          expect(holds({ field: "data.domain", op: "in", value: values }, event)).toBe(
            values.some((value) => holds({ field: "data.domain", op: "eq", value }, event)),
          );
        },
      ),
      RUNS,
    );
  });

  it("a domain pattern `*.x` matches exactly the proper subdomains of x", () => {
    fc.assert(
      fc.property(domainArb, fc.constantFrom(...DOMAIN_POOL), (domain, base) => {
        const matches = holds(
          { field: "data.domain", op: "domain_matches", value: `*.${base}` },
          pageVisited({ domain }),
        );
        expect(matches).toBe(domain.endsWith(`.${base}`));
      }),
      RUNS,
    );
  });
});

describe("what an allowed result contains", () => {
  it("is a valid event that holds no more than the input did (invariant 3)", () => {
    fc.assert(
      fc.property(eventArb, rulesArb(), policyArb, contextArb, (event, rules, policy, ctx) => {
        const set = compile(rules);
        const result = evaluate(event, set, policy, ctx);
        expect(result.decision).not.toBe("error");
        if (result.decision !== "allow") return;

        const input = event as {
          id: string;
          type: string;
          typeVersion: number;
          occurredAt: string;
          data: Record<string, unknown>;
        };
        const out = result.event as unknown as typeof input;
        expect(parseEvent(out).ok).toBe(true);
        expect([out.id, out.type, out.typeVersion, out.occurredAt]).toEqual([
          input.id,
          input.type,
          input.typeVersion,
          input.occurredAt,
        ]);
        // Transforms only remove fields and shorten the path.
        for (const key of Object.keys(out.data)) expect(input.data).toHaveProperty(key);
        for (const [key, value] of Object.entries(out.data)) {
          if (key !== "path") expect(value).toBe(input.data[key]);
        }
        if (typeof out.data.path === "string") {
          expect(String(input.data.path).startsWith(out.data.path)).toBe(true);
          expect(out.data.path).not.toMatch(/[?#]/);
        }
      }),
      RUNS,
    );
  });

  it("process results respect the context and the rules that matched", () => {
    fc.assert(
      fc.property(eventArb, rulesArb(), policyArb, contextArb, (event, rules, policy, ctx) => {
        const set = compile(rules);
        const result = evaluate(event, set, policy, ctx);
        if (result.decision !== "allow") return;
        expect(new Set(result.tags).size).toBe(result.tags.length);
        const processIds = new Set(set.process.map((r) => r.id));
        const matchedProcess = result.trace.matched.filter((m) => processIds.has(m.ruleId));
        if (ctx.process === false) {
          expect(matchedProcess).toEqual([]);
          expect(result.tags).toEqual([]);
          expect(result.retentionDays).toBeNull();
        }
        const retentions = set.process
          .filter((r) => matchedProcess.some((m) => m.ruleId === r.id))
          .flatMap((r) => r.then)
          .flatMap((a) => (a.action === "set_retention" ? [a.days] : []));
        expect(result.retentionDays).toBe(retentions.length === 0 ? null : Math.min(...retentions));
      }),
      RUNS,
    );
  });
});

describe("the trace and a dropped result hold no values (invariants 2 and 6)", () => {
  it("is valid for ruleTraceSchema, names only rules and actions, and agrees with the decision", () => {
    fc.assert(
      fc.property(eventArb, rulesArb(), policyArb, contextArb, (event, rules, policy, ctx) => {
        const set = compile(rules);
        const result = evaluate(event, set, policy, ctx);
        if (result.decision === "error") return;
        expect(ruleTraceSchema.safeParse(result.trace).success).toBe(true);
        expect(result.trace.ruleSetVersion).toBe(set.version);
        for (const match of result.trace.matched) {
          for (const action of match.actions) expect(RULE_ACTION_NAMES).toContain(action);
        }
        const ids = result.trace.matched.map((m) => m.ruleId);
        expect(new Set(ids).size).toBe(ids.length);
        if (result.trace.decidedBy === "default_policy") {
          expect(result.decision).toBe(policy === "allow" ? "allow" : "drop");
        } else {
          expect(ids).toContain(result.trace.decidedBy);
        }
      }),
      RUNS,
    );
  });

  it("a dropped result is only a decision and a trace, and the trace leaks no event data", () => {
    fc.assert(
      fc.property(eventArb, rulesArb(), contextArb, (event, rules, ctx) => {
        const set = compile([...rules, rule(99, { priority: 0, then: [{ action: "drop" }] })]);
        const result = evaluate(event, set, "allow", ctx);
        expect(result.decision).toBe("drop");
        expect(Object.keys(result).sort()).toEqual(["decision", "trace"]);
        const text = JSON.stringify(result);
        const data = (event as { data: Record<string, unknown> }).data;
        for (const key of ["domain", "path", "tabRef"]) {
          const value = data[key];
          if (typeof value === "string") expect(text).not.toContain(value);
        }
      }),
      RUNS,
    );
  });
});

describe("idempotent transforms", () => {
  const dataArb = fc.record({
    domain: domainArb,
    path: pathArb,
    transition: fc.constantFrom("link", "typed", undefined),
  });
  const actionsArb = fc.array(
    fc.oneof(
      fc.integer({ min: 0, max: 10 }).map((segments) => ({ action: "coarsen", segments }) as const),
      fc.constant({ action: "redact", field: "data.transition" } as const),
      fc.constant({ action: "keep_query" } as const),
      fc.constant({ action: "allow" } as const),
      fc.constant({ action: "tag", tag: "t" } as const),
    ),
    { maxLength: 8 },
  );

  function run(actions: Parameters<typeof applyTransform>[0][], data: Record<string, unknown>) {
    const copy = { ...data };
    const state: TransformState = { keepQuery: false };
    for (const action of actions) applyTransform(action, copy, state);
    return { data: copy, state };
  }

  it("unconditionally: applying any list of transforms twice equals applying it once", () => {
    fc.assert(
      fc.property(dataArb, actionsArb, (data, actions) => {
        const once = run(actions, data);
        const twice = run(actions, once.data);
        expect(twice.data).toEqual(once.data);
      }),
      RUNS,
    );
  });

  it("coarsenPath: keeps a prefix, never grows, is idempotent, and composes to the smaller N", () => {
    fc.assert(
      fc.property(
        pathArb,
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 10 }),
        (path, a, b) => {
          const once = coarsenPath(path, a);
          expect(once.startsWith("/")).toBe(true);
          expect(path.startsWith(once)).toBe(true);
          expect(once.length).toBeLessThanOrEqual(path.length);
          expect(coarsenPath(once, a)).toBe(once);
          expect(coarsenPath(once, b)).toBe(coarsenPath(path, Math.min(a, b)));
        },
      ),
      RUNS,
    );
  });

  it("the event is stable when evaluated again (rules that read only fields no rule rewrites)", () => {
    fc.assert(
      fc.property(
        eventArb,
        rulesArb({ domainOnly: true }),
        policyArb,
        contextArb,
        (event, rules, policy, ctx) => {
          const set = compile(rules);
          const first = evaluate(event, set, policy, ctx);
          if (first.decision !== "allow") return;
          const second = allowed(evaluate(first.event, set, policy, ctx));
          // Here the decision is stable too, because every condition reads the untouched domain.
          expect(second).toEqual(first);
        },
      ),
      RUNS,
    );
  });
});

describe("invalid input fails closed (invariant 1)", () => {
  const allowAll = compile([
    rule(1),
    rule(2, { stage: "process", then: [{ action: "tag", tag: "t" }] }),
  ]);
  const EXT: EvaluateContext = { source: "browser-extension" };

  it("never throws on any event, and only a valid event is ever collected", () => {
    fc.assert(
      fc.property(fc.anything(), (event) => {
        const result = evaluate(event, allowAll, "allow", EXT);
        if (parseEvent(event).ok) expect(result.decision).toBe("allow");
        else expect(result).toEqual({ decision: "error", reason: "invalid_event" });
      }),
      { numRuns: 500 },
    );
  });

  it("a broken event is an error, not a decision, even with allow-everything rules", () => {
    const breakers: ((e: Record<string, unknown>) => Record<string, unknown>)[] = [
      (e) => ({ ...e, extra: 1 }),
      (e) => ({ ...e, userId: "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b" }),
      (e) => ({ ...e, type: "browser.unknown" }),
      (e) => ({ ...e, typeVersion: 99 }),
      (e) => ({ ...e, id: "not-a-uuid" }),
      (e) => ({ ...e, occurredAt: "yesterday" }),
      (e) => ({ ...e, data: { ...(e.data as object), extra: 1 } }),
      (e) => ({ ...e, data: { ...(e.data as object), title: "Secret page" } }),
      (e) => ({ ...e, data: { ...(e.data as object), domain: "UPPER.example.org" } }),
      (e) => ({ ...e, data: { ...(e.data as object), domain: "github.com/path" } }),
      (e) => ({ ...e, data: { ...(e.data as object), path: "/a?token=1" } }),
      (e) => ({ ...e, data: { ...(e.data as object), path: "/a#frag" } }),
      (e) => ({ ...e, data: { ...(e.data as object), path: "no-slash" } }),
      (e) => ({ ...e, data: undefined }),
    ];
    fc.assert(
      fc.property(eventArb, fc.constantFrom(...breakers), (event, breaker) => {
        const broken = breaker(event);
        // Some breakers do not apply to every type (a tab event has no path). Only judge the
        // ones that really produce something `parseEvent` refuses.
        fc.pre(!parseEvent(broken).ok);
        expect(evaluate(broken, allowAll, "allow", EXT)).toEqual({
          decision: "error",
          reason: "invalid_event",
        });
      }),
      RUNS,
    );
  });

  it("never throws on any context, and only a known source is accepted", () => {
    fc.assert(
      fc.property(fc.anything(), (context) => {
        const result = evaluate(pageVisited(), allowAll, "allow", context as never);
        const source = (context as { source?: unknown } | null | undefined)?.source;
        const known =
          typeof source === "string" && (INTEGRATION_KINDS as readonly string[]).includes(source);
        // A context that is not even an object throws on the way in; that is an error too.
        if (!known) {
          expect(result.decision).toBe("error");
          expect(["invalid_context", "failed"]).toContain((result as { reason: string }).reason);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("never throws on a garbage rule set, and collects nothing", () => {
    const garbage = fc
      .anything()
      .filter((item) => !(typeof item === "object" && item !== null && "when" in item));
    fc.assert(
      fc.property(
        fc.record({
          version: fc.anything(),
          collect: fc.array(garbage, { minLength: 1, maxLength: 3 }),
          process: fc.oneof(fc.constant([]), fc.array(garbage, { maxLength: 2 })),
        }),
        eventArb,
        policyArb,
        (ruleSet, event, policy) => {
          const result = evaluate(event, ruleSet as never, policy, EXT);
          expect(result).toEqual({ decision: "error", reason: "failed" });
        },
      ),
      RUNS,
    );
  });

  it("compileRuleSet never throws on any input and accepts only what the schema accepts", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const result = compileRuleSet(input);
        expect(result.ok).toBe(ruleSetSchema.safeParse(input).success);
      }),
      { numRuns: 500 },
    );
  });
});

describe("an invalid rule set is refused whole, without echoing its values", () => {
  const SECRET = "sentinel-secret.example";
  const breakers: ((r: Record<string, unknown>) => Record<string, unknown>)[] = [
    (r) => ({ ...r, extra: SECRET }),
    (r) => ({ ...r, priority: 1001 }),
    (r) => ({ ...r, priority: -1 }),
    (r) => ({ ...r, priority: 1.5 }),
    (r) => ({ ...r, name: "" }),
    (r) => ({ ...r, enabled: "yes" }),
    (r) => ({ ...r, stage: "later" }),
    (r) => ({ ...r, then: [] }),
    (r) => ({ ...r, then: [{ action: "forward" }] }),
    (r) => ({ ...r, then: [{ action: "exec", command: SECRET }] }),
    (r) => ({ ...r, then: [{ action: "allow" }, { action: "drop" }] }),
    (r) => ({ ...r, when: { all: [] } }),
    (r) => ({
      ...r,
      when: { all: [{ field: "data.domain", op: "matches_regex", value: SECRET }] },
    }),
    (r) => ({ ...r, when: { all: [{ field: "data.nope", op: "eq", value: SECRET }] } }),
    (r) => ({
      ...r,
      when: { all: [{ field: "data.domain", op: "eq", value: SECRET.toUpperCase() }] },
    }),
    (r) => ({ ...r, when: { all: [{ field: "data.domain", op: "eq", value: SECRET, extra: 1 }] } }),
    (r) => ({ ...r, when: { type: ["browser.nothing_like_this"] } }),
    (r) => ({ ...r, when: { source: ["carrier-pigeon"] } }),
    (r) => ({ ...r, when: { unknown: SECRET } }),
  ];

  it("any single broken rule invalidates the set, the whole set, even if the rule is disabled", () => {
    fc.assert(
      fc.property(
        rulesArb(),
        fc.nat(),
        fc.constantFrom(...breakers),
        fc.boolean(),
        versionArb,
        (rules, at, breaker, disabled, version) => {
          const list: Record<string, unknown>[] = [...rules, rule(50)];
          const index = at % list.length;
          list[index] = breaker({
            ...(list[index] as Record<string, unknown>),
            ...(disabled ? { enabled: false } : {}),
          });
          const result = compileRuleSet({ version, rules: list });
          // A breaker that happens to produce a valid rule would be a generator bug.
          expect(ruleSetSchema.safeParse({ version, rules: list }).success).toBe(false);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.issues.length).toBeGreaterThan(0);
            expect(JSON.stringify(result.issues).toLowerCase()).not.toContain("sentinel-secret");
          }
        },
      ),
      RUNS,
    );
  });

  it("duplicate rule ids are refused", () => {
    fc.assert(
      fc.property(rulesArb(), (rules) => {
        const copy = { ...rule(50), id: ruleId(1) };
        const result = compileRuleSet({ version: 1, rules: [rule(1), copy, ...rules.slice(1)] });
        expect(result.ok).toBe(false);
      }),
      RUNS,
    );
  });
});
