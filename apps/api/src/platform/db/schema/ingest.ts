import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const userId = () =>
  text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** A source of events (the extension, or any HTTP client). The server derives it from the key. */
export const integrations = pgTable(
  "integrations",
  {
    id: id(),
    userId: userId(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    defaultPolicy: text("default_policy").notNull().default("deny"),
    status: text("status").notNull().default("active"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastHeartbeat: jsonb("last_heartbeat"),
    createdAt: createdAt(),
  },
  (table) => [
    index("integrations_user_id_idx").on(table.userId),
    check("integrations_kind_check", sql`${table.kind} IN ('browser-extension', 'http')`),
    check("integrations_default_policy_check", sql`${table.defaultPolicy} IN ('deny', 'allow')`),
    check("integrations_status_check", sql`${table.status} IN ('active', 'revoked')`),
  ],
);

/** Only the SHA-256 hash is stored; the plaintext key is shown once. endpoint_id arrives in M5. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    userId: userId(),
    kind: text("kind").notNull(),
    integrationId: uuid("integration_id").references(() => integrations.id, {
      onDelete: "cascade",
    }),
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull(),
    scopes: jsonb("scopes").notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("api_keys_hash_idx").on(table.hash),
    index("api_keys_user_id_idx").on(table.userId),
    check("api_keys_kind_check", sql`${table.kind} IN ('ingest', 'read')`),
    check(
      "api_keys_ingest_integration_check",
      sql`${table.kind} <> 'ingest' OR ${table.integrationId} IS NOT NULL`,
    ),
  ],
);

export const events = pgTable(
  "events",
  {
    id: id(),
    userId: userId(),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    clientEventId: text("client_event_id").notNull(),
    type: text("type").notNull(),
    typeVersion: integer("type_version").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** The client's original value when occurred_at was clamped (non-null = future-timestamp flag). */
    clientOccurredAt: timestamp("client_occurred_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    origin: text("origin").notNull().default("collected"),
    data: jsonb("data").notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    /** Nullable until M4 (rule trace). */
    trace: jsonb("trace"),
    /** Nullable until M6-01 (retention). */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    unique("events_dedupe_key").on(table.userId, table.integrationId, table.clientEventId),
    index("events_user_occurred_idx").on(table.userId, table.occurredAt.desc(), table.id),
    index("events_user_type_occurred_idx").on(table.userId, table.type, table.occurredAt),
    index("events_expires_at_idx").on(table.expiresAt),
    check("events_origin_check", sql`${table.origin} IN ('collected', 'imported', 'derived')`),
  ],
);

/** Hourly counters only. Never payloads. */
export const ingestionLog = pgTable(
  "ingestion_log",
  {
    id: id(),
    userId: userId(),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    bucket: timestamp("bucket", { withTimezone: true }).notNull(),
    accepted: integer("accepted").notNull().default(0),
    duplicate: integer("duplicate").notNull().default(0),
    dropped: integer("dropped").notNull().default(0),
    rejected: integer("rejected").notNull().default(0),
    byReason: jsonb("by_reason").notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    unique("ingestion_log_bucket_key").on(table.userId, table.integrationId, table.bucket),
  ],
);
