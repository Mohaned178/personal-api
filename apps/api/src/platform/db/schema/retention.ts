import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * How long a user keeps events of one type or from one source. `target` is an event type name
 * (`scope = 'type'`) or an integration id as text (`scope = 'source'`); it is text so it needs no
 * foreign key, and the service checks the integration belongs to the user. Events beat these with a
 * `set_retention` rule, and the default (90 days) applies when no policy matches.
 */
export const retentionPolicies = pgTable(
  "retention_policies",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    target: text("target").notNull(),
    days: integer("days").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("retention_policies_target_key").on(table.userId, table.scope, table.target),
    check("retention_policies_scope_check", sql`${table.scope} IN ('source', 'type')`),
    check("retention_policies_days_check", sql`${table.days} BETWEEN 1 AND 3650`),
  ],
);
