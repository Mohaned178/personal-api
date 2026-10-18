import { Injectable } from "@nestjs/common";
import { type CompiledRuleSet, compileRuleSet } from "@personal-api/rules";
import { ZodError } from "zod";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { RulesRepository } from "./rules.repository";

/**
 * A user's rules ready to run. `compiled` is null when they cannot be run (a stored rule no longer
 * fits the schema, or the set does not compile): the caller fails closed (invariant 1) and never
 * evaluates a partial set. `version` is the rule-set version the answer belongs to.
 */
export interface LoadedRuleSet {
  version: number;
  compiled: CompiledRuleSet | null;
}

/** Most users kept in memory; the oldest entry goes first. Plenty for a self-hosted install. */
export const RULE_SET_CACHE_MAX_USERS = 500;

/**
 * The compiled rule set per user, kept in memory and checked against the database on every use:
 * one cheap `rule_sets.version` read decides whether the cached set is still the current one, so a
 * rule change takes effect on the user's next batch, also on another API instance. Keys are user
 * ids from the AuthContext only (invariant 4). Nothing here logs.
 */
@Injectable()
export class RuleSetProvider {
  private readonly cache = new Map<string, LoadedRuleSet>();

  constructor(private readonly repository: RulesRepository) {}

  /**
   * Forgets every cached set. Versions only ever go up while a user's `rule_sets` row exists, so
   * production never needs this; tests that empty the rule tables do.
   */
  clear(): void {
    this.cache.clear();
  }

  async get(userId: string): Promise<LoadedRuleSet> {
    assertUserScope(userId);
    const version = await this.repository.readVersion(userId);
    const cached = this.cache.get(userId);
    if (cached !== undefined && cached.version === version) return cached;

    let stored: Awaited<ReturnType<RulesRepository["list"]>>;
    try {
      stored = await this.repository.list(userId);
    } catch (error) {
      // A stored rule that fails the schema is a configuration fault, not a database fault: fail
      // closed. Anything else (connection, timeout) propagates, so the client retries.
      if (error instanceof ZodError) return { version, compiled: null };
      throw error;
    }
    const result = compileRuleSet({ version: stored.version, rules: stored.rules });
    const loaded: LoadedRuleSet = {
      version: stored.version,
      compiled: result.ok ? result.ruleSet : null,
    };
    // Keyed by the version `list()` read, which can be newer than the one checked above.
    this.cache.delete(userId);
    this.cache.set(userId, loaded);
    if (this.cache.size > RULE_SET_CACHE_MAX_USERS) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    return loaded;
  }
}
