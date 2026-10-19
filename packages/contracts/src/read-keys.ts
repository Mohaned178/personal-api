import { z } from "zod";
import { safeMessage } from "./errors.js";
import { utcDateTimeSchema } from "./primitives.js";
import { typePatternSchema } from "./rules.js";

/**
 * Read keys (`pa_read_`, PLAN §6 `/v1/keys`). A read key can only read, within its scopes, and
 * optionally only some sources and event types. Requests are strict: tenancy (`userId`), the key
 * kind and the integration never come from the body.
 */

export const READ_KEY_NAME_MAX_LENGTH = 80;
export const READ_KEY_MAX_SOURCES = 20;
export const READ_KEY_MAX_TYPES = 20;

/** The scopes a user can put on a key through `POST /v1/keys`. */
export const READ_SCOPES = ["events:read", "activity:read"] as const;
export type ReadScope = (typeof READ_SCOPES)[number];

/** `endpoint:<id>`: read one saved-query endpoint only. Minted with the endpoint (M5-05), not by `POST /v1/keys`. */
const ENDPOINT_SCOPE_PATTERN =
  /^endpoint:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function endpointScope(endpointId: string): string {
  return `endpoint:${endpointId}`;
}

/**
 * Everything a stored key may carry. The guard parses the stored scopes with this and refuses the
 * key if any entry does not parse, so a corrupted row can never grant more than it says.
 */
export const readScopeSchema = z.union([
  z.enum(READ_SCOPES),
  z.string().regex(ENDPOINT_SCOPE_PATTERN, safeMessage("Expected a scope like endpoint:<uuid>")),
]);

/**
 * Narrows what a key reads. `sources` are integration ids; `types` are event types or `*` globs,
 * judged by the same schema as the `type` of a rule (lowercase letters, digits, `_`, `.` and `*`,
 * so a pattern never carries a SQL LIKE wildcard, a regex or a space). A key matches an event when
 * it passes every list that is present. "No restriction" is `null` on the key, never `{}`.
 */
export const readKeyRestrictionSchema = z
  .strictObject({
    sources: z.array(z.uuid()).min(1).max(READ_KEY_MAX_SOURCES).optional(),
    types: z.array(typePatternSchema).min(1).max(READ_KEY_MAX_TYPES).optional(),
  })
  .refine((r) => r.sources !== undefined || r.types !== undefined, {
    message: safeMessage("Expected sources or types"),
  });
export type ReadKeyRestriction = z.output<typeof readKeyRestrictionSchema>;

export const readKeyNameSchema = z.string().trim().min(1).max(READ_KEY_NAME_MAX_LENGTH);

export const createReadKeyRequestSchema = z.strictObject({
  name: readKeyNameSchema.optional(),
  scopes: z
    .array(z.enum(READ_SCOPES))
    .min(1)
    .max(READ_SCOPES.length)
    .refine((scopes) => new Set(scopes).size === scopes.length, {
      message: safeMessage("Scopes must not repeat"),
    }),
  restriction: readKeyRestrictionSchema.optional(),
});
export type CreateReadKeyRequest = z.output<typeof createReadKeyRequestSchema>;

/** A read key as the API returns it. Never the secret and never the hash. */
export const readKeySchema = z.strictObject({
  id: z.uuid(),
  name: z.string().nullable(),
  /** Display-only leading part of the key, enough to tell keys apart. */
  prefix: z.string(),
  scopes: z.array(readScopeSchema),
  restriction: readKeyRestrictionSchema.nullable(),
  createdAt: utcDateTimeSchema,
  lastUsedAt: utcDateTimeSchema.nullable(),
  revokedAt: utcDateTimeSchema.nullable(),
});
export type ReadKey = z.output<typeof readKeySchema>;

/** The create response: the only place the plaintext `key` (`pa_read_...`) ever appears. */
export const createReadKeyResponseSchema = z.strictObject({
  readKey: readKeySchema,
  key: z.string(),
});
export type CreateReadKeyResponse = z.output<typeof createReadKeyResponseSchema>;

export const readKeyResponseSchema = z.strictObject({ readKey: readKeySchema });
export type ReadKeyResponse = z.output<typeof readKeyResponseSchema>;

export const readKeyListResponseSchema = z.strictObject({ readKeys: z.array(readKeySchema) });
export type ReadKeyListResponse = z.output<typeof readKeyListResponseSchema>;

/** 404 for an unknown, foreign, malformed or non-read key id (all look the same). */
export const READ_KEY_NOT_FOUND_CODE = "key.not_found";

/** 403 when a valid read key lacks the scope the route needs. */
export const INSUFFICIENT_SCOPE_CODE = "auth.insufficient_scope";
