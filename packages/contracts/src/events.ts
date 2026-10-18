import { z } from "zod";
import { domainSchema, utcDateTimeSchema } from "./primitives.js";
import { ruleTraceSchema } from "./rule-trace.js";

/**
 * Stored-event DTOs for the dashboard (PLAN §6, `GET /v1/events`, `DELETE /v1/events`). Requests
 * are strict: tenancy (`userId`) never comes from the query or the body, and an unknown key is a
 * 400 `request.invalid`.
 */

export const EVENTS_DEFAULT_LIMIT = 50;
export const EVENTS_MAX_LIMIT = 200;
export const EVENTS_DELETE_MAX_IDS = 100;
export const EVENT_TYPE_MAX_LENGTH = 64;

/** Code of the 404 for an unknown, foreign or malformed event id (all look the same). */
export const EVENT_NOT_FOUND_CODE = "event.not_found";
/** Code of the 400 for a cursor that was not issued by this API. */
export const EVENTS_CURSOR_INVALID_CODE = "events.cursor_invalid";

/** Query-string integers arrive as strings. */
const limitSchema = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(EVENTS_MAX_LIMIT));

/**
 * Filters for `GET /v1/events`. `source` is an integration id. `from` is inclusive and `to` is
 * exclusive, so adjacent windows never share an event. `domain` matches `data.domain` exactly.
 * `cursor` is the opaque `nextCursor` of the previous page (keyset on `(occurred_at, id)`).
 */
export const listEventsQuerySchema = z.strictObject({
  source: z.uuid().optional(),
  type: z.string().min(1).max(EVENT_TYPE_MAX_LENGTH).optional(),
  from: utcDateTimeSchema.optional(),
  to: utcDateTimeSchema.optional(),
  domain: domainSchema.optional(),
  cursor: z.string().min(1).max(256).optional(),
  limit: limitSchema.optional(),
});
export type ListEventsQuery = z.output<typeof listEventsQuerySchema>;

/**
 * A stored event as the API returns it. `trace` is why it was kept ("why is this here"); it is null
 * for an event stored before rules existed. `expiresAt` is left out until retention (M6) gives it
 * a meaning; the field list is explicit so a new column cannot leak.
 */
export const storedEventSchema = z.strictObject({
  id: z.uuid(),
  integrationId: z.uuid(),
  type: z.string(),
  typeVersion: z.number().int(),
  occurredAt: utcDateTimeSchema,
  receivedAt: utcDateTimeSchema,
  origin: z.enum(["collected", "imported", "derived"]),
  data: z.record(z.string(), z.unknown()),
  tags: z.array(z.string()),
  trace: ruleTraceSchema.nullable(),
});
export type StoredEvent = z.output<typeof storedEventSchema>;

export const listEventsResponseSchema = z.strictObject({
  events: z.array(storedEventSchema),
  /** Null on the last page. */
  nextCursor: z.string().nullable(),
});
export type ListEventsResponse = z.output<typeof listEventsResponseSchema>;

export const getEventResponseSchema = z.strictObject({ event: storedEventSchema });
export type GetEventResponse = z.output<typeof getEventResponseSchema>;

/** Delete by ids. Delete by filter arrives with data management (M6). */
export const deleteEventsRequestSchema = z.strictObject({
  ids: z.array(z.uuid()).min(1).max(EVENTS_DELETE_MAX_IDS),
});
export type DeleteEventsRequest = z.output<typeof deleteEventsRequestSchema>;

/** Ids that are unknown or not the user's are not counted, and not told apart. */
export const deleteEventsResponseSchema = z.strictObject({ deleted: z.number().int().min(0) });
export type DeleteEventsResponse = z.output<typeof deleteEventsResponseSchema>;
