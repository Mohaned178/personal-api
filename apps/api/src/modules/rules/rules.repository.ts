import { Inject, Injectable } from "@nestjs/common";
import {
  RULES_PER_USER_MAX,
  type Rule,
  type RuleDefinition,
  ruleSchema,
} from "@personal-api/contracts";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { ruleHistory, ruleSets, rules } from "../../platform/db/schema";
import { type TenantScope, tenantScope } from "../../platform/db/tenant-scope";

type RuleRow = typeof rules.$inferSelect;

/** A user's rules at one rule-set version, in list order (priority, then id). */
export interface StoredRuleSet {
  version: number;
  rules: Rule[];
}

export interface StoredRule {
  rule: Rule;
  /** The rule-set version this answer belongs to. */
  version: number;
}

/** Why a change was refused. Nothing was written, and the version did not move. */
export type RuleChangeRefusal = "not_found" | "limit_reached";

export type RuleChangeResult = StoredRule | RuleChangeRefusal;

/**
 * Every public method takes `userId` as its FIRST argument and goes through `tenantScope`, so a
 * missing or blank userId rejects with `MissingUserScopeError` before the database is touched.
 * Keep helpers out of the class (or prefix them with `_`): the scoping spec walks the prototype.
 *
 * Every change (create, replace, delete) runs in ONE transaction that locks the user's
 * `rule_sets` row, applies the change, bumps the version and writes the `rule_history` snapshot,
 * so versions are gapless and a snapshot always matches its version.
 */
@Injectable()
export class RulesRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Rules and version from one snapshot, so a concurrent change cannot give a mixed answer. */
  async list(userId: string): Promise<StoredRuleSet> {
    tenantScope(this.db, userId);
    return this.db.transaction(
      async (tx) => {
        const scope = tenantScope(tx, userId);
        return { version: await readVersion(scope), rules: await readRules(scope) };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async findById(userId: string, id: string): Promise<StoredRule | null> {
    tenantScope(this.db, userId);
    return this.db.transaction(
      async (tx) => {
        const scope = tenantScope(tx, userId);
        const [row] = await scope.select(rules, eq(rules.id, id));
        return row ? { rule: toRule(row), version: await readVersion(scope) } : null;
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  create(userId: string, definition: RuleDefinition, at: Date): Promise<RuleChangeResult> {
    return changeRuleSet(this.db, userId, at, async (scope) => {
      if ((await scope.select(rules)).length >= RULES_PER_USER_MAX) return "limit_reached";
      const [row] = await scope.insert(rules, {
        ...columnsOf(definition),
        createdAt: at,
        updatedAt: at,
      });
      if (!row) throw new Error("rule insert returned no row");
      return toRule(row);
    });
  }

  replace(
    userId: string,
    id: string,
    definition: RuleDefinition,
    at: Date,
  ): Promise<RuleChangeResult> {
    return changeRuleSet(this.db, userId, at, async (scope) => {
      const [row] = await scope.update(
        rules,
        { ...columnsOf(definition), updatedAt: at },
        eq(rules.id, id),
      );
      return row ? toRule(row) : "not_found";
    });
  }

  remove(userId: string, id: string, at: Date): Promise<RuleChangeResult> {
    return changeRuleSet(this.db, userId, at, async (scope) => {
      const [row] = await scope.delete(rules, eq(rules.id, id));
      return row ? toRule(row) : "not_found";
    });
  }
}

/** The ordering and filtering columns, always derived from the definition they sit beside. */
function columnsOf(definition: RuleDefinition) {
  return {
    name: definition.name,
    enabled: definition.enabled,
    priority: definition.priority,
    stage: definition.stage,
    definition,
  };
}

/**
 * Parsed again on the way out: a stored document that no longer fits the schema is a 500, never a
 * rule the dashboard or the extension would run in a different shape (invariant 1).
 */
function toRule(row: RuleRow): Rule {
  return ruleSchema.parse({ id: row.id, ...(row.definition as object) });
}

async function readVersion(scope: TenantScope): Promise<number> {
  const [row] = await scope.select(ruleSets);
  return row?.version ?? 0;
}

async function readRules(scope: TenantScope): Promise<Rule[]> {
  const rows = await scope.select(rules);
  return rows.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1)).map(toRule);
}

/**
 * Runs `change` under the user's rule-set lock. `change` returns the affected rule, or a refusal,
 * which rolls nothing back (nothing was written) and leaves the version alone.
 */
async function changeRuleSet(
  db: Database,
  userId: string,
  at: Date,
  change: (scope: TenantScope) => Promise<Rule | RuleChangeRefusal>,
): Promise<RuleChangeResult> {
  tenantScope(db, userId);
  return db.transaction(async (tx) => {
    const scope = tenantScope(tx, userId);
    // The row must exist to be locked. Concurrent first changes both reach the lock below.
    await tx.insert(ruleSets).values({ userId }).onConflictDoNothing();
    await tx.select().from(ruleSets).where(eq(ruleSets.userId, userId)).for("update");

    const changed = await change(scope);
    if (typeof changed === "string") return changed;

    const [bumped] = await scope.update(ruleSets, {
      version: sql`${ruleSets.version} + 1`,
      updatedAt: at,
    });
    if (!bumped) throw new Error("rule set row vanished under its lock");
    await scope.insert(ruleHistory, {
      ruleSetVersion: bumped.version,
      snapshot: await readRules(scope),
    });
    return { rule: changed, version: bumped.version };
  });
}
