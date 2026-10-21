// Fixtures for the M4-06 rules tests: rules, configs, stored rules and a plain storage fake.

import type {
  FocusSession,
  IngestConfigResponse,
  Limit,
  Rule,
  Schedule,
} from "@personal-api/contracts";
import type { Connection } from "../../lib/connect";
import { activeRules, type StoredRules } from "../../lib/rules/active-rules";
import { RULES_STORAGE_KEY } from "../../lib/rules/storage-key";
import { connectionFor, KEY, ownerOf, pick } from "../queue/support/world";

export { RULES_STORAGE_KEY };

let counter = 0;
/** A valid, unique rule id. */
export const ruleId = (): string => {
  counter += 1;
  return `0192f1c2-7c1e-7a3b-9f00-${String(counter).padStart(12, "0")}`;
};

export function domainRule(
  name: string,
  domain: string,
  action: "allow" | "drop",
  overrides: Partial<Rule> = {},
): Rule {
  return {
    id: ruleId(),
    name,
    enabled: true,
    priority: 10,
    stage: "collect",
    when: { all: [{ field: "data.domain", op: "eq", value: domain }] },
    then: [{ action }],
    ...overrides,
  } as Rule;
}

export function configOf(
  rules: Rule[],
  options: {
    version?: number;
    defaultPolicy?: "allow" | "deny";
    limits?: Limit[];
    focus?: FocusSession | null;
    schedules?: Schedule[];
  } = {},
): IngestConfigResponse {
  return {
    ruleSetVersion: options.version ?? rules.length,
    defaultPolicy: options.defaultPolicy ?? "deny",
    rules,
    limits: options.limits ?? [],
    focus: options.focus ?? null,
    schedules: options.schedules ?? [],
  };
}

export function storedRules(
  config: IngestConfigResponse,
  options: { connection?: Connection; etag?: string } = {},
): StoredRules {
  return {
    owner: ownerOf(options.connection ?? connectionFor()),
    etag: options.etag ?? '"etag-1"',
    config,
  };
}

/** Rules ready to run for the default connection. */
export function active(config: IngestConfigResponse) {
  const result = activeRules(storedRules(config), connectionFor());
  if (result === null) throw new Error("the fixture config does not compile");
  return result;
}

/** A `storage.local` over a plain object, the same shape the wiring and the sync read. */
export function memoryStorage(initial: Record<string, unknown> = {}) {
  const stored: Record<string, unknown> = { ...initial };
  return {
    stored,
    get: async (keys: string | string[]) => pick(stored, keys),
    set: async (items: Record<string, unknown>) => void Object.assign(stored, items),
    remove: async (keys: string | string[]) => {
      for (const key of [keys].flat()) delete stored[key];
    },
  };
}

export { connectionFor, KEY };
