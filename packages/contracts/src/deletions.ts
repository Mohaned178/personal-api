import { z } from "zod";
import { deleteEventsRequestSchema, listEventsQuerySchema } from "./events.js";
import { integrationSchema } from "./integrations.js";
import { utcDateTimeSchema } from "./primitives.js";

/**
 * Bulk deletion (PLAN §6, `DELETE /v1/events` with a filter, `DELETE /v1/integrations/:id/data`).
 * A deletion is a job: the request answers 202 with a `deletion` the client polls at
 * `GET /v1/events/deletions/:id` until it is `completed` or `failed`. Requests are strict, and
 * tenancy never comes from the body.
 */

/** Code of the 404 for an unknown, foreign or malformed deletion id (all look the same). */
export const DELETION_NOT_FOUND_CODE = "deletion.not_found";

/**
 * Which events to delete. The same fields as the list filter (`source` is an integration id,
 * `from` inclusive, `to` exclusive). At least one is required: "delete everything" is not a
 * filter, account deletion is the way to do that.
 */
export const deletionFilterSchema = z
  .strictObject(
    listEventsQuerySchema.pick({ source: true, type: true, from: true, to: true, domain: true })
      .shape,
  )
  .refine((filter) => Object.values(filter).some((value) => value !== undefined), {
    message: "A filter needs at least one field",
  });
export type DeletionFilter = z.output<typeof deletionFilterSchema>;

export const deleteEventsByFilterRequestSchema = z.strictObject({ filter: deletionFilterSchema });
export type DeleteEventsByFilterRequest = z.output<typeof deleteEventsByFilterRequestSchema>;

/**
 * `DELETE /v1/events` takes `ids` (answers 200 `{deleted}`) or a `filter` (answers 202), never
 * both. One object with an exactly-one check, not a union, so a DTO class can be built from it.
 */
export const deleteEventsBodySchema = z
  .strictObject({
    ids: deleteEventsRequestSchema.shape.ids.optional(),
    filter: deletionFilterSchema.optional(),
  })
  .refine((body) => (body.ids === undefined) !== (body.filter === undefined), {
    message: "Send either ids or a filter",
  });

export const DELETION_KINDS = ["events", "integration"] as const;
export const DELETION_STATUSES = ["queued", "running", "completed", "failed"] as const;

/**
 * `total` is the number of matching events counted when the job starts (null until then), so
 * `deleted / total` is progress. It is an estimate: events that arrive during the run can make
 * `deleted` pass it.
 */
export const deletionSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(DELETION_KINDS),
  status: z.enum(DELETION_STATUSES),
  total: z.number().int().min(0).nullable(),
  deleted: z.number().int().min(0),
  createdAt: utcDateTimeSchema,
  finishedAt: utcDateTimeSchema.nullable(),
});
export type Deletion = z.output<typeof deletionSchema>;

export const deletionResponseSchema = z.strictObject({ deletion: deletionSchema });
export type DeletionResponse = z.output<typeof deletionResponseSchema>;

/** The answer to "disconnect and delete this integration's data": the revoked source and the job. */
export const deleteIntegrationDataResponseSchema = z.strictObject({
  integration: integrationSchema,
  deletion: deletionSchema,
});
export type DeleteIntegrationDataResponse = z.output<typeof deleteIntegrationDataResponseSchema>;
