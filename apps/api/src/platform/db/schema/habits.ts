import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * A user's override of a site's category (M9-07): a domain pattern (`example.com` or
 * `*.example.com`) and `productive`, `neutral` or `distracting`. It beats the built-in preset
 * list when the split is computed; nothing is written onto events. Domains, so never logged.
 */
export const siteCategories = pgTable(
  "site_categories",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    pattern: text("pattern").notNull(),
    category: text("category").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("site_categories_pattern_key").on(table.userId, table.pattern),
    check(
      "site_categories_category_check",
      sql`${table.category} IN ('productive', 'neutral', 'distracting')`,
    ),
  ],
);

/** A daily ceiling on one category (M9-07), at most one per user and category. */
export const categoryGoals = pgTable(
  "category_goals",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    minutes: integer("minutes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("category_goals_category_key").on(table.userId, table.category),
    check("category_goals_category_check", sql`${table.category} IN ('distracting', 'neutral')`),
    check("category_goals_minutes_check", sql`${table.minutes} BETWEEN 1 AND 1440`),
  ],
);
