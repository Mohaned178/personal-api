import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * One data export, produced by a job (M6-05). `filter` is the validated `ExportFilter`; the job
 * reads it from here, so the queue message carries only ids. `file_path` is the events file, relative
 * to `EXPORT_DIR`, and is set when the export completes. The row holds the filter, counters and a
 * path, never events. The files themselves are removed by the cleanup job and by account deletion.
 */
// `exports` is a reserved name in a CommonJS module, so the table object is `dataExports`.
export const dataExports = pgTable(
  "exports",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    filter: jsonb("filter").notNull(),
    filePath: text("file_path"),
    eventCount: integer("event_count"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    index("exports_user_id_created_at_idx").on(table.userId, table.createdAt, table.id),
    index("exports_expires_at_idx").on(table.expiresAt),
    check(
      "exports_status_check",
      sql`${table.status} IN ('queued', 'running', 'completed', 'failed')`,
    ),
  ],
);
