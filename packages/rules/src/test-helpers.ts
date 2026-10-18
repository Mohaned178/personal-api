import type { Rule } from "@personal-api/contracts";
import { compileRuleSet } from "./compile.js";
import type { CompiledRuleSet } from "./types.js";

export const UUID_V7 = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";
export const TAB_REF = "k3j2h1g4f5d6a7b8";

/** Stable, distinct rule ids: `ruleId(1)` < `ruleId(2)` as strings. */
export function ruleId(n: number): string {
  return `0192f1c2-7c1e-7a3b-9f00-${String(n).padStart(12, "0")}`;
}

export function pageVisited(data: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: UUID_V7,
    type: "browser.page_visited",
    typeVersion: 1,
    occurredAt: "2026-10-13T10:05:00.000Z",
    data: {
      domain: "github.com",
      path: "/Mohaned178/IdentiK",
      transition: "link",
      tabRef: TAB_REF,
      ...data,
    },
  };
}

export function tabOpened(data: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: UUID_V7,
    type: "browser.tab_opened",
    typeVersion: 1,
    occurredAt: "2026-10-13T10:05:00.000Z",
    data: { tabRef: TAB_REF, domain: "github.com", ...data },
  };
}

export function focusSegment(data: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: UUID_V7,
    type: "browser.focus_segment",
    typeVersion: 1,
    occurredAt: "2026-10-13T10:05:00.000Z",
    data: {
      domain: "github.com",
      path: "/Mohaned178/IdentiK",
      startedAt: "2026-10-13T10:00:00.000Z",
      endedAt: "2026-10-13T10:05:00.000Z",
      durationMs: 300_000,
      ...data,
    },
  };
}

/** A valid rule; `n` gives it an id. Override any part. */
export function rule(n: number, overrides: Record<string, unknown> = {}): Rule {
  return {
    id: ruleId(n),
    name: `Rule ${n}`,
    enabled: true,
    priority: 100,
    stage: "collect",
    when: {},
    then: [{ action: "allow" }],
    ...overrides,
  } as Rule;
}

/** Compiles rules and fails the test if they are not a valid set. */
export function compile(rules: readonly Rule[], version = 7): CompiledRuleSet {
  const result = compileRuleSet({ version, rules });
  if (!result.ok) throw new Error(`rules did not compile: ${JSON.stringify(result.issues)}`);
  return result.ruleSet;
}
