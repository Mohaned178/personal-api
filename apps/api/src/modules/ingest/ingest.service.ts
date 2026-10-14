import { Inject, Injectable } from "@nestjs/common";
import {
  eventIdSchema,
  type HeartbeatRequest,
  INGEST_BATCH_INVALID_CODE,
  type IngestBatchResponse,
  type IngestErrorCode,
  type IngestItemResult,
  ingestBatchRequestSchema,
  isPlainObject,
  parseEvent,
  toContractIssues,
} from "@personal-api/contracts";
import type { z } from "zod";
import { CLOCK, type Clock } from "../../platform/clock/clock";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { AppException } from "../../platform/errors/problem";
import { INVALID_KEY_CODE } from "../keys/ingest-key.guard";
import { type IngestionCounts, IngestRepository, type NewEvent } from "./ingest.repository";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Events whose `occurredAt` is further than this before the server clock are rejected with
 * `ingest.occurred_at_too_old` (inclusive: exactly 90 days old is accepted). Fixed until M6 makes
 * it follow the user's retention.
 */
export const INGEST_MAX_EVENT_AGE_MS = 90 * DAY_MS;

/**
 * Events whose `occurredAt` is further than this ahead of the server clock are clamped to
 * `receivedAt`, and the original is kept in `client_occurred_at` (exactly 5 minutes ahead is kept
 * as sent).
 */
export const INGEST_MAX_FUTURE_SKEW_MS = 5 * MINUTE_MS;

/** The start of `at`'s UTC hour: the `ingestion_log` bucket. */
export function hourBucket(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

/** What happens to one item of a batch, decided before anything is stored. */
export type ItemPlan =
  | { kind: "rejected"; code: IngestErrorCode; id?: string }
  /** The first valid occurrence of its id in the batch: inserted unless already stored. */
  | { kind: "store"; event: NewEvent }
  /** A later valid occurrence of an id stored earlier in the same batch: always a duplicate. */
  | { kind: "repeat"; id: string };

/**
 * Decides each item on its own, in request order. `parseEvent()` runs first, so its code wins
 * over the age check. The age check uses the client's original `occurredAt`, so clamping never
 * rescues an old event. Only validated output reaches a `store` plan, never the raw input.
 */
export function planBatch(items: readonly unknown[], receivedAt: Date): ItemPlan[] {
  const now = receivedAt.getTime();
  const seen = new Set<string>();
  return items.map((item): ItemPlan => {
    const parsed = parseEvent(item);
    if (!parsed.ok) return rejected(parsed.code, eventIdOf(item));
    const { event } = parsed;
    const occurredAt = Date.parse(event.occurredAt);
    // The contract only accepts parseable date-times; this keeps one bad item from failing the batch.
    if (!Number.isFinite(occurredAt)) return rejected("ingest.envelope_invalid", event.id);
    if (now - occurredAt > INGEST_MAX_EVENT_AGE_MS) {
      return rejected("ingest.occurred_at_too_old", event.id);
    }
    if (seen.has(event.id)) return { kind: "repeat", id: event.id };
    seen.add(event.id);
    const clamped = occurredAt - now > INGEST_MAX_FUTURE_SKEW_MS;
    return {
      kind: "store",
      event: {
        clientEventId: event.id,
        type: event.type,
        typeVersion: event.typeVersion,
        occurredAt: new Date(clamped ? now : occurredAt),
        clientOccurredAt: clamped ? new Date(occurredAt) : null,
        receivedAt: new Date(now),
        data: event.data,
      },
    };
  });
}

/**
 * Per-item results in request order. Whether a stored item is `accepted` or `duplicate` comes
 * only from `stored`, the ids the insert returned. Never `dropped` before rules exist (M4-05).
 */
export function toResults(
  plan: readonly ItemPlan[],
  stored: ReadonlySet<string>,
): IngestItemResult[] {
  return plan.map((item): IngestItemResult => {
    if (item.kind === "rejected") {
      return item.id === undefined
        ? { status: "rejected", code: item.code }
        : { id: item.id, status: "rejected", code: item.code };
    }
    if (item.kind === "repeat") return { id: item.id, status: "duplicate" };
    const id = item.event.clientEventId;
    return { id, status: stored.has(id) ? "accepted" : "duplicate" };
  });
}

/** The `ingestion_log` counters for a set of results: rejected items are counted by code. */
export function countResults(results: readonly IngestItemResult[]): IngestionCounts {
  const counts: IngestionCounts = {
    accepted: 0,
    duplicate: 0,
    dropped: 0,
    rejected: 0,
    byReason: {},
  };
  for (const result of results) {
    counts[result.status] += 1;
    if (result.status === "rejected") {
      counts.byReason[result.code] = (counts.byReason[result.code] ?? 0) + 1;
    }
  }
  return counts;
}

/** integrations.last_seen_at is written at most once per this interval per integration. */
export const LAST_SEEN_UPDATE_INTERVAL_MS = 60_000;

@Injectable()
export class IngestService {
  constructor(
    private readonly repository: IngestRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * `POST /v1/ingest/events`. A body that fails the batch shape is one 400 problem+json
   * (`ingest.batch_invalid`) and stores nothing. Otherwise each item gets its own result, valid
   * events are stored, and the hourly counters are updated, all in one transaction. `userId` and
   * `integrationId` and `keyId` come from the ingest AuthContext only (invariant 4). If the key was
   * revoked since the guard ran, nothing is stored and the answer is the guard's 401. Nothing here
   * logs.
   */
  async ingestBatch(
    userId: string,
    integrationId: string,
    keyId: string,
    body: unknown,
  ): Promise<IngestBatchResponse> {
    assertUserScope(userId);
    const batch = ingestBatchRequestSchema.safeParse(body);
    if (!batch.success) throw batchInvalid(batch.error);

    const receivedAt = this.clock.now();
    const plan = planBatch(batch.data.events, receivedAt);
    const events = plan.flatMap((item) => (item.kind === "store" ? [item.event] : []));
    const stored = await this.repository.storeBatch(
      userId,
      integrationId,
      keyId,
      { events, bucket: hourBucket(receivedAt) },
      (ids) => countResults(toResults(plan, ids)),
    );
    // The key or its integration was revoked after the guard let this request through.
    if (stored === null) throw new AppException(401, INVALID_KEY_CODE, "Invalid API key");
    await this.repository.touchLastSeen(
      userId,
      integrationId,
      receivedAt,
      LAST_SEEN_UPDATE_INTERVAL_MS,
    );
    return { results: toResults(plan, stored) };
  }

  /**
   * `POST /v1/ingest/heartbeat`. The body was validated by the contract (strict). Stores it as the
   * integration's `last_heartbeat` and bumps `last_seen_at` (throttled). Scope comes from the
   * ingest AuthContext only (invariant 4). Nothing here logs.
   */
  async recordHeartbeat(
    userId: string,
    integrationId: string,
    heartbeat: HeartbeatRequest,
  ): Promise<void> {
    assertUserScope(userId);
    await this.repository.recordHeartbeat(
      userId,
      integrationId,
      { ...heartbeat },
      this.clock.now(),
      LAST_SEEN_UPDATE_INTERVAL_MS,
    );
  }
}

function rejected(code: IngestErrorCode, id: string | undefined): ItemPlan {
  return id === undefined ? { kind: "rejected", code } : { kind: "rejected", code, id };
}

/**
 * The item's id when it is a valid event id (lowercased), so a rejection can echo it. Like
 * `parseEvent()`, it never throws: an item that cannot be read has no id.
 */
function eventIdOf(item: unknown): string | undefined {
  try {
    if (!isPlainObject(item)) return undefined;
    const id = eventIdSchema.safeParse(item.id);
    return id.success ? id.data : undefined;
  } catch {
    return undefined;
  }
}

/** Issues carry paths and schema-written messages only, never input (invariant 6). */
function batchInvalid(error: z.ZodError): AppException {
  return new AppException(400, INGEST_BATCH_INVALID_CODE, "Invalid ingest batch", undefined, {
    issues: toContractIssues(error.issues),
  });
}
