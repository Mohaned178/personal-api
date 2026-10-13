import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Tiny key/value table for instance-level facts (for example a schema bootstrap marker).
 * It exists so the very first migration is real and the migrate pipeline can be proven
 * end to end; domain tables arrive in later tasks.
 */
export const appMeta = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
