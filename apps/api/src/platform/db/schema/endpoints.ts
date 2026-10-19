import { sql } from "drizzle-orm";
import { boolean, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * A user-defined endpoint (`GET /v1/me/:slug`): a slug and a saved query. `definition` is the
 * `SavedQueryDefinition` as stored; it is parsed again whenever it is read, because it comes out of
 * jsonb. The slug is unique per user.
 */
export const endpoints = pgTable(
  "endpoints",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    definition: jsonb("definition").notNull(),
    enabled: boolean("enabled").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("endpoints_user_slug_key").on(table.userId, table.slug)],
);
