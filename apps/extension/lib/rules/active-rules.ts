// M4-06 the rules the extension runs: read from `browser.storage.local`, validated, compiled and
// bound to the connection they were fetched for. Every failure is `null`, and null means "collect
// nothing" (invariant 1).

import {
  type IngestConfigResponse,
  ingestConfigResponseSchema,
  type KnownEvent,
  type Limit,
} from "@personal-api/contracts";
import {
  type CompiledRuleSet,
  compileRuleSet,
  type DefaultPolicy,
  evaluate,
} from "@personal-api/rules";
import { CONNECTION_STORAGE_KEY, type Connection, parseStoredConnection } from "../connect";
import { connectionOwner, sameQueueOwner } from "../gate-mirror";
import { CLIENT_VERSION } from "../heartbeat";
import type { QueueOwner } from "../queue/types";
import { RULES_STORAGE_KEY } from "./storage-key";

export { RULES_STORAGE_KEY };

/** What `sync` stores: the config as the server sent it, the validator it came with, and its owner. */
export interface StoredRules {
  /** The server and integration the rules were fetched for. Rules of another owner never apply. */
  owner: QueueOwner;
  /** The response's ETag, sent back as `If-None-Match`. Empty when the server sent none. */
  etag: string;
  config: IngestConfigResponse;
}

/** Rules that passed every check and can be run. */
export interface ActiveRules {
  /** The rule-set version, stamped on every event as `meta.ruleSetVersion`. */
  version: number;
  defaultPolicy: DefaultPolicy;
  ruleSet: CompiledRuleSet;
  /** Rule id to name, for the popup's "blocked by rule X". */
  ruleNames: ReadonlyMap<string, string>;
}

/** The ETag of a stored value, or null when the value is not a well-formed `StoredRules`. */
export function parseStoredRules(value: unknown): StoredRules | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { owner, etag, config } = value as Record<string, unknown>;
  if (typeof owner !== "object" || owner === null || Array.isArray(owner)) return null;
  const { serverOrigin, integrationId } = owner as Record<string, unknown>;
  if (typeof serverOrigin !== "string" || typeof integrationId !== "string") return null;
  if (typeof etag !== "string") return null;
  const parsed = ingestConfigResponseSchema.safeParse(config);
  if (!parsed.success) return null;
  return { owner: { serverOrigin, integrationId }, etag, config: parsed.data };
}

/** Compiles a validated config. Null when the engine refuses the set (one bad rule voids all). */
export function compileConfig(config: IngestConfigResponse): ActiveRules | null {
  const compiled = compileRuleSet({ version: config.ruleSetVersion, rules: config.rules });
  if (!compiled.ok) return null;
  return {
    version: config.ruleSetVersion,
    defaultPolicy: config.defaultPolicy,
    ruleSet: compiled.ruleSet,
    ruleNames: new Map(config.rules.map((rule) => [rule.id, rule.name])),
  };
}

/**
 * The rules to run for `connection`, or null: no connection, nothing stored, a malformed or
 * invalid value, a set the engine refuses, or rules fetched for another server or integration.
 */
export function activeRules(stored: unknown, connection: Connection | null): ActiveRules | null {
  try {
    if (connection === null) return null;
    const rules = parseStoredRules(stored);
    if (rules === null) return null;
    if (!sameQueueOwner(rules.owner, connectionOwner(connection))) return null;
    return compileConfig(rules.config);
  } catch {
    return null;
  }
}

/**
 * M9-02 the daily limits that came with the rules, or an empty list: no limit is enforced unless
 * the rules around it are valid, bound to this connection and accepted by the engine.
 */
export function activeLimits(stored: unknown, connection: Connection | null): Limit[] {
  try {
    if (activeRules(stored, connection) === null) return [];
    return parseStoredRules(stored)?.config.limits ?? [];
  } catch {
    return [];
  }
}

/** The storage side `readActiveRules` needs. Both keys are read in ONE call. */
export interface RulesStorage {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
}

/** Reads the connection and the rules together and returns the rules to run, or null. Never rejects. */
export async function readActiveRules(storage: RulesStorage): Promise<ActiveRules | null> {
  try {
    const raw = await storage.get([CONNECTION_STORAGE_KEY, RULES_STORAGE_KEY]);
    return activeRules(raw[RULES_STORAGE_KEY], parseStoredConnection(raw[CONNECTION_STORAGE_KEY]));
  } catch {
    return null;
  }
}

/** The `client` of `meta`: `pa-extension/<version>`. */
export const EVENT_CLIENT = `pa-extension/${CLIENT_VERSION}`;

/**
 * Runs the collect rules on events the capture engine produced. An event is kept only when the
 * engine says `allow`: a `drop`, an `error` or anything unexpected removes it (invariant 1), and a
 * dropped event is gone for good (invariant 2). A kept event is the engine's output, so `redact` and
 * `coarsen` hold, stamped with the rule-set version these rules have (`meta`), so the server knows
 * which rules already decided it. Never throws.
 */
export function applyRules(active: ActiveRules, events: readonly KnownEvent[]): KnownEvent[] {
  const kept: KnownEvent[] = [];
  for (const event of events) {
    try {
      const result = evaluate(event, active.ruleSet, active.defaultPolicy, {
        source: "browser-extension",
        process: false,
      });
      if (result.decision !== "allow") continue;
      kept.push({
        ...result.event,
        meta: { ruleSetVersion: active.version, client: EVENT_CLIENT },
      });
    } catch {
      // Fail closed: the event is not kept.
    }
  }
  return kept;
}
