import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * One bulk deletion of events, run by a job (M6-03). `filter` is the validated `DeletionFilter`;
 * the job reads it from here, so the queue message carries only ids. `total` is counted when the
 * job starts and `deleted` grows per batch. The row holds counters and the filter, never events.
 */
export const bulkDeletions = pgTable(
  "bulk_deletions",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    filter: jsonb("filter").notNull(),
    status: text("status").notNull().default("queued"),
    total: integer("total"),
    deleted: integer("deleted").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("bulk_deletions_user_id_idx").on(table.userId),
    check("bulk_deletions_kind_check", sql`${table.kind} IN ('events', 'integration')`),
    check(
      "bulk_deletions_status_check",
      sql`${table.status} IN ('queued', 'running', 'completed', 'failed')`,
    ),
  ],
);
