import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

const userId = () =>
  text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" });

/**
 * One row per user once they change a rule; no row means version 0. `version` bumps on every
 * create, update and delete, in the same transaction as the change. The row is also the lock that
 * serializes a user's rule changes.
 */
export const ruleSets = pgTable(
  "rule_sets",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("rule_sets_version_check", sql`${table.version} >= 0`)],
);

/**
 * `definition` is the whole `RuleDefinition` (the source of truth). The other columns copy parts
 * of it for ordering and filtering and are always written from the same object.
 */
export const rules = pgTable(
  "rules",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: userId(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull(),
    priority: integer("priority").notNull(),
    stage: text("stage").notNull(),
    definition: jsonb("definition").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("rules_user_priority_idx").on(table.userId, table.priority, table.id),
    check("rules_stage_check", sql`${table.stage} IN ('collect', 'process')`),
  ],
);

/**
 * The rules as they were at each rule-set version, so an old event's trace (rule ids) stays
 * explainable after the rule changed or was deleted. `snapshot` is the array of stored rules.
 */
export const ruleHistory = pgTable(
  "rule_history",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: userId(),
    ruleSetVersion: integer("rule_set_version").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("rule_history_version_key").on(table.userId, table.ruleSetVersion)],
);
