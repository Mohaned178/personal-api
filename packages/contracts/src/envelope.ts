import { z } from "zod";
import { safeMessage } from "./errors.js";
import { eventIdSchema, utcDateTimeSchema } from "./primitives.js";

/** Client metadata attached to an event. Optional, so plain HTTP clients can omit it. */
export const eventMetaSchema = z.strictObject({
  ruleSetVersion: z.int().min(0),
  client: z.string().min(1).max(100),
});
export type EventMeta = z.output<typeof eventMetaSchema>;

/** A plain JSON object (not an array, not null). Passed through as is for the payload schema. */
const dataObjectSchema = z.custom<Record<string, unknown>>(isPlainObject, {
  message: safeMessage("Expected an object"),
});

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The event envelope a source sends (PLAN §4). Strict: unknown keys are rejected. In particular
 * `userId`, `integrationId`, `receivedAt` and `origin` are set by the server from the key, never
 * taken from the body. `data` is only checked to be an object here; its shape is checked by the
 * event-type registry once `type` and `typeVersion` are known.
 */
export const eventEnvelopeSchema = z.strictObject({
  id: eventIdSchema,
  type: z.string().min(1).max(128),
  typeVersion: z.int().min(1),
  occurredAt: utcDateTimeSchema,
  data: dataObjectSchema,
  meta: eventMetaSchema.optional(),
});
export type EventEnvelope = z.output<typeof eventEnvelopeSchema>;
