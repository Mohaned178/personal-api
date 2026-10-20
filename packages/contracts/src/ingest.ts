import { z } from "zod";
import { ingestErrorCodeSchema } from "./errors.js";
import { eventIdSchema } from "./primitives.js";

/** Most events in one `POST /v1/ingest/events` request (inclusive). */
export const INGEST_MAX_BATCH_EVENTS = 100;

/** Largest `POST /v1/ingest/events` body in bytes (enforced by the body parser, PLAN §6). */
export const INGEST_MAX_BATCH_BYTES = 256 * 1024;

/**
 * Body of `POST /v1/ingest/events`. Only the batch shape and size are checked here: each item is
 * validated on its own with `parseEvent()`, so one malformed event gets its own `rejected` result
 * instead of failing the batch. Strict: tenancy (`userId`, `integrationId`) never comes from the
 * body.
 */
export const ingestBatchRequestSchema = z.strictObject({
  events: z.array(z.unknown()).min(1).max(INGEST_MAX_BATCH_EVENTS),
});
export type IngestBatchRequest = z.output<typeof ingestBatchRequestSchema>;

/**
 * Whole-request code (problem+json, 400) for a body that fails `ingestBatchRequestSchema`: no
 * `events` array, an empty one, more than `INGEST_MAX_BATCH_EVENTS`, or an unknown top-level key.
 * Not a per-item code: no item is looked at, and nothing is stored.
 */
export const INGEST_BATCH_INVALID_CODE = "ingest.batch_invalid";

export const INGEST_ITEM_STATUSES = ["accepted", "duplicate", "dropped", "rejected"] as const;
export type IngestItemStatus = (typeof INGEST_ITEM_STATUSES)[number];

/**
 * The result for one event, in the same position as the event in the request. It carries the
 * event id and a status, plus a stable code when rejected. It never carries the payload. A
 * rejected event whose id was malformed has no id to echo.
 */
export const ingestItemResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    id: eventIdSchema,
    status: z.enum(["accepted", "duplicate", "dropped"]),
  }),
  z.strictObject({
    id: eventIdSchema.optional(),
    status: z.literal("rejected"),
    code: ingestErrorCodeSchema,
  }),
]);
export type IngestItemResult = z.output<typeof ingestItemResultSchema>;

/** Response body of `POST /v1/ingest/events`. */
export const ingestBatchResponseSchema = z.strictObject({
  results: z.array(ingestItemResultSchema).max(INGEST_MAX_BATCH_EVENTS),
});
export type IngestBatchResponse = z.output<typeof ingestBatchResponseSchema>;

/** Longest `clientVersion` in a heartbeat, in UTF-16 code units. */
export const HEARTBEAT_CLIENT_VERSION_MAX = 64;

/**
 * Body of `POST /v1/ingest/heartbeat`: queue health the client reports about itself. Strict, so
 * tenancy never comes from the body. Counts are non-negative safe integers. `clientVersion` is
 * bounded and has no control characters or lone surrogates (Postgres `jsonb` refuses the latter).
 */
export const heartbeatRequestSchema = z.strictObject({
  queueDepth: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  oldestQueuedAgeMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  droppedCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  clientVersion: z
    .string()
    .min(1)
    .max(HEARTBEAT_CLIENT_VERSION_MAX)
    .regex(/^[^\p{Cc}\p{Cs}]*$/u, "must not contain control characters"),
});
export type HeartbeatRequest = z.output<typeof heartbeatRequestSchema>;

/** Problem+json code (429, with `Retry-After`) when one ingest key sends too many requests. */
export const INGEST_RATE_LIMITED_CODE = "ingest.rate_limited";
