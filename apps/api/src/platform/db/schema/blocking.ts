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
 * A repeating block on sites (M9-06): domain patterns, the weekdays it starts on (0 = Monday) and
 * two local times of day. The extension enforces it on the device in the device's own time zone;
 * the server only stores it and hands the enabled ones out with the rules. Domains and the name
 * are the user's own text, so never logged.
 */
export const siteSchedules = pgTable(
  "site_schedules",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    patterns: text("patterns").array().notNull(),
    days: integer("days").array().notNull(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("site_schedules_times_check", sql`${table.startTime} <> ${table.endTime}`)],
);

/**
 * The user's running focus session (M9-06): domain patterns blocked until `ends_at`. One per user;
 * starting a new one replaces it. A session whose end has passed is never handed out.
 */
export const focusSessions = pgTable(
  "focus_sessions",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    patterns: text("patterns").array().notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("focus_sessions_user_key").on(table.userId)],
);
