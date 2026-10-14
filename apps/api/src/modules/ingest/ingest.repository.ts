import { Inject, Injectable } from "@nestjs/common";
import type { IngestErrorCode } from "@personal-api/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { events, ingestionLog } from "../../platform/db/schema";
import {
  type TenantDb,
  TenantScopeViolationError,
  tenantScope,
} from "../../platform/db/tenant-scope";
import { isUuid } from "../../platform/db/uuid";

/** One validated event, ready to store. Tenancy is added by the repository, never by the caller. */
export interface NewEvent {
  /** The client's event id, lowercased by the contracts (the dedupe key). */
  clientEventId: string;
  type: string;
  typeVersion: number;
  /** After clamping: never more than the allowed skew ahead of `receivedAt`. */
  occurredAt: Date;
  /** The client's original `occurredAt` when it was clamped, otherwise null. */
  clientOccurredAt: Date | null;
  receivedAt: Date;
  data: Record<string, unknown>;
}

/** Counters added to one hourly `ingestion_log` row. Error codes only, never payloads. */
export interface IngestionCounts {
  accepted: number;
  duplicate: number;
  dropped: number;
  rejected: number;
  byReason: Partial<Record<IngestErrorCode, number>>;
}

export interface StoreBatchInput {
  /** Events to insert, with distinct `clientEventId`s. May be empty (every item was rejected). */
  events: readonly NewEvent[];
  /** The `ingestion_log` bucket: the start of the server clock's UTC hour. */
  bucket: Date;
}

/**
 * Every public method takes `userId` as its FIRST argument and builds a `tenantScope` before
 * anything else, so a missing or blank userId rejects with `MissingUserScopeError` before the
 * database is touched. Keep helpers out of the class (or prefix them with `_`): the scoping spec
 * walks the prototype.
 */
@Injectable()
export class IngestRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Stores a batch in ONE transaction: `INSERT … ON CONFLICT DO NOTHING … RETURNING` for the
   * events, then the hourly `ingestion_log` upsert. `summarize` receives the client event ids the
   * insert actually stored (from RETURNING, never from a prior SELECT) and returns the counters,
   * so the log always matches what the caller is told. If either write fails, neither is kept.
   * Returns the stored ids.
   *
   * `userId` and `integrationId` come from the ingest AuthContext only (invariant 4). Neither
   * insert can go through `scope.insert` (it has no ON CONFLICT option), so both stamp
   * `scope.userId` on their row themselves, the way `scope.insert` does. The conflict targets
   * include `user_id`, so neither statement can ever match another user's row.
   */
  async storeBatch(
    userId: string,
    integrationId: string,
    batch: StoreBatchInput,
    summarize: (stored: ReadonlySet<string>) => IngestionCounts,
  ): Promise<ReadonlySet<string>> {
    // Built first, so a missing userId rejects before the database is touched.
    tenantScope(this.db, userId);
    if (!isUuid(integrationId)) {
      throw new TenantScopeViolationError("an integration id from the auth context is required");
    }
    return this.db.transaction(async (tx) => {
      const scope = tenantScope(tx, userId);
      const stored = await insertNewEvents(tx, scope.userId, integrationId, batch.events);
      await addCounts(tx, scope.userId, integrationId, batch.bucket, summarize(stored));
      return stored;
    });
  }
}

/**
 * Inserts the events that are not stored yet and returns the client event ids it inserted. A
 * conflict on the dedupe key `(user_id, integration_id, client_event_id)` is a duplicate and
 * inserts nothing. Any other conflict (a row id collision) still fails the transaction.
 *
 * Rows go in sorted by client event id, so two concurrent batches that share ids wait on each
 * other in the same order and cannot deadlock.
 */
async function insertNewEvents(
  tx: TenantDb,
  userId: string,
  integrationId: string,
  rows: readonly NewEvent[],
): Promise<ReadonlySet<string>> {
  if (rows.length === 0) return new Set();
  const values = [...rows]
    .sort((a, b) => compare(a.clientEventId, b.clientEventId))
    .map((row) => ({ ...row, userId, integrationId, origin: "collected" }));
  const inserted = await tx
    .insert(events)
    .values(values)
    .onConflictDoNothing({ target: [events.userId, events.integrationId, events.clientEventId] })
    .returning({ clientEventId: events.clientEventId });
  return new Set(inserted.map((row) => row.clientEventId));
}

/**
 * Adds `counts` to the (user, integration, bucket) row, creating it if needed. The row lock taken
 * by ON CONFLICT DO UPDATE makes concurrent requests add up exactly. `by_reason` is merged key by
 * key: counts for the same error code are summed, new codes are added.
 */
async function addCounts(
  tx: TenantDb,
  userId: string,
  integrationId: string,
  bucket: Date,
  counts: IngestionCounts,
): Promise<void> {
  await tx
    .insert(ingestionLog)
    .values({ userId, integrationId, bucket, ...counts })
    .onConflictDoUpdate({
      target: [ingestionLog.userId, ingestionLog.integrationId, ingestionLog.bucket],
      set: {
        accepted: sql`${ingestionLog.accepted} + excluded.accepted`,
        duplicate: sql`${ingestionLog.duplicate} + excluded.duplicate`,
        dropped: sql`${ingestionLog.dropped} + excluded.dropped`,
        rejected: sql`${ingestionLog.rejected} + excluded.rejected`,
        byReason: sql`${ingestionLog.byReason} || coalesce(
          (select jsonb_object_agg(
             added.key,
             coalesce((${ingestionLog.byReason} ->> added.key)::int, 0) + added.value::int)
           from jsonb_each_text(excluded.by_reason) as added),
          '{}'::jsonb)`,
      },
    });
}

function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
