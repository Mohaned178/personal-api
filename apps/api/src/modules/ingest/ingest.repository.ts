import { Inject, Injectable } from "@nestjs/common";
import { DEFAULT_POLICIES, INTEGRATION_KINDS, type RuleTrace } from "@personal-api/contracts";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { apiKeys, events, ingestionLog, integrations } from "../../platform/db/schema";
import {
  scopeCondition,
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
  /** After the rules' redact and coarsen. */
  data: Record<string, unknown>;
  tags: string[];
  /** Why the event is kept: rule ids and action names only. */
  trace: RuleTrace;
  /** `receivedAt` plus the resolved retention days (rule, type policy, source policy, default). */
  expiresAt: Date;
}

/** The part of an integration the rules need: its kind and what it does when no rule decides. */
export interface Caller {
  kind: (typeof INTEGRATION_KINDS)[number];
  defaultPolicy: (typeof DEFAULT_POLICIES)[number];
}

/**
 * Counters added to one hourly `ingestion_log` row. `byReason` keys are ingest error codes for
 * rejected items, and a rule id or `default_policy` for dropped ones. Never payloads.
 */
export interface IngestionCounts {
  accepted: number;
  duplicate: number;
  dropped: number;
  rejected: number;
  byReason: Record<string, number>;
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
   * The kind and default policy of the caller's own active integration, or null when it is gone
   * or revoked (the caller answers 401). They decide how the rules treat the batch, so they come
   * from the database, never from the request (invariant 4).
   */
  async loadCaller(userId: string, integrationId: string): Promise<Caller | null> {
    const scope = tenantScope(this.db, userId);
    assertIntegrationId(integrationId);
    const [row] = await scope.select(
      integrations,
      and(eq(integrations.id, integrationId), eq(integrations.status, "active")),
    );
    if (!row) return null;
    const kind = INTEGRATION_KINDS.find((candidate) => candidate === row.kind);
    const defaultPolicy = DEFAULT_POLICIES.find((candidate) => candidate === row.defaultPolicy);
    // The columns have CHECK constraints; a value outside them is a bug, never "allow".
    if (kind === undefined || defaultPolicy === undefined) {
      throw new Error("integration row holds an unknown kind or default policy");
    }
    return { kind, defaultPolicy };
  }

  /**
   * Stores a batch in ONE transaction: `INSERT … ON CONFLICT DO NOTHING … RETURNING` for the
   * events, then the hourly `ingestion_log` upsert. `summarize` receives the client event ids the
   * insert actually stored (from RETURNING, never from a prior SELECT) and returns the counters,
   * so the log always matches what the caller is told. If either write fails, neither is kept.
   * Returns the stored ids.
   *
   * The transaction starts by locking the caller's integration and then its key FOR SHARE, each
   * only while still live (`status = 'active'`, `revoked_at IS NULL`). A revoke that committed
   * after the guard ran (or commits while this waits: READ COMMITTED re-checks the predicate once
   * the lock is granted) leaves no row, and this returns null with nothing written. A revoke that
   * arrives later waits for this transaction, so the batch is ordered before it. The lock order
   * (integration, then key) is the one `IntegrationsRepository.revoke` uses, so they cannot
   * deadlock. Null means "the key is no longer valid": the caller answers 401.
   *
   * `userId` and `integrationId` come from the ingest AuthContext only (invariant 4). Neither
   * insert can go through `scope.insert` (it has no ON CONFLICT option), so both stamp
   * `scope.userId` on their row themselves, the way `scope.insert` does. The conflict targets
   * include `user_id`, so neither statement can ever match another user's row.
   */
  async storeBatch(
    userId: string,
    integrationId: string,
    keyId: string,
    batch: StoreBatchInput,
    summarize: (stored: ReadonlySet<string>) => IngestionCounts,
  ): Promise<ReadonlySet<string> | null> {
    // Built first, so a missing userId rejects before the database is touched.
    tenantScope(this.db, userId);
    assertIntegrationId(integrationId);
    if (!isUuid(keyId)) {
      throw new TenantScopeViolationError("a key id from the auth context is required");
    }
    return this.db.transaction(async (tx) => {
      const scope = tenantScope(tx, userId);
      if (!(await lockLiveCaller(tx, scope.userId, integrationId, keyId))) return null;
      const stored = await insertNewEvents(tx, scope.userId, integrationId, batch.events);
      await addCounts(tx, scope.userId, integrationId, batch.bucket, summarize(stored));
      return stored;
    });
  }

  /**
   * Sets last_seen_at to `at` unless it was already set within `intervalMs` before `at`. The
   * condition is in the UPDATE itself, so concurrent requests write once. Touches only the
   * caller's own active integration. Returns whether a row was written.
   */
  async touchLastSeen(
    userId: string,
    integrationId: string,
    at: Date,
    intervalMs: number,
  ): Promise<boolean> {
    const scope = tenantScope(this.db, userId);
    assertIntegrationId(integrationId);
    const rows = await scope.update(
      integrations,
      { lastSeenAt: at },
      and(
        eq(integrations.id, integrationId),
        eq(integrations.status, "active"),
        or(
          isNull(integrations.lastSeenAt),
          lte(integrations.lastSeenAt, new Date(at.getTime() - intervalMs)),
        ),
      ),
    );
    return rows.length > 0;
  }

  /**
   * Stores `heartbeat` as last_heartbeat (always: it is the latest report) and bumps last_seen_at
   * under the same throttle as `touchLastSeen`, in one UPDATE on the caller's active integration.
   */
  async recordHeartbeat(
    userId: string,
    integrationId: string,
    heartbeat: Record<string, unknown>,
    at: Date,
    intervalMs: number,
  ): Promise<boolean> {
    const scope = tenantScope(this.db, userId);
    assertIntegrationId(integrationId);
    const stale = new Date(at.getTime() - intervalMs);
    const rows = await scope.update(
      integrations,
      {
        lastHeartbeat: heartbeat,
        lastSeenAt: sql`case when ${integrations.lastSeenAt} is null or ${integrations.lastSeenAt} <= ${sql.param(stale, integrations.lastSeenAt)} then ${sql.param(at, integrations.lastSeenAt)} else ${integrations.lastSeenAt} end`,
      },
      and(eq(integrations.id, integrationId), eq(integrations.status, "active")),
    );
    return rows.length > 0;
  }
}

function assertIntegrationId(integrationId: string): void {
  if (!isUuid(integrationId)) {
    throw new TenantScopeViolationError("an integration id from the auth context is required");
  }
}

/**
 * Locks the caller's active integration, then its live key, FOR SHARE until the transaction ends.
 * Two statements, in the order `IntegrationsRepository.revoke` takes its row locks. False when
 * either is gone or revoked. Neither select can use `scope.select` (it has no lock option); both
 * AND the user scope through `scopeCondition`, the way `ApiKeysRepository.insertIngestKey` does.
 */
async function lockLiveCaller(
  tx: TenantDb,
  userId: string,
  integrationId: string,
  keyId: string,
): Promise<boolean> {
  const [integration] = await tx
    .select({ id: integrations.id })
    .from(integrations)
    .where(
      scopeCondition(
        integrations,
        userId,
        and(eq(integrations.id, integrationId), eq(integrations.status, "active")),
      ),
    )
    .for("share");
  if (!integration) return false;
  const [key] = await tx
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      scopeCondition(
        apiKeys,
        userId,
        and(
          eq(apiKeys.id, keyId),
          eq(apiKeys.integrationId, integrationId),
          isNull(apiKeys.revokedAt),
        ),
      ),
    )
    .for("share");
  return key !== undefined;
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
