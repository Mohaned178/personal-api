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
