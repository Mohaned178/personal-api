import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * A daily limit on a site (M9-02): a domain pattern (`example.com` or `*.example.com`) plus
 * minutes per day. `strict` turns off "5 more minutes" until the user's local midnight. The
 * extension enforces limits on the device; the server only stores them and hands them out with the
 * rules. Domains, so never logged. One limit per pattern and user.
 */
export const siteLimits = pgTable(
  "site_limits",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    pattern: text("pattern").notNull(),
    minutes: integer("minutes").notNull(),
    strict: boolean("strict").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("site_limits_pattern_key").on(table.userId, table.pattern),
    check("site_limits_minutes_check", sql`${table.minutes} BETWEEN 1 AND 1440`),
  ],
);
