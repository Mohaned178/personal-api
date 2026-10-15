import { z } from "zod";
import { utcDateTimeSchema } from "./primitives.js";

/**
 * Integration DTOs (PLAN §6, `/v1/integrations`). Requests are strict: tenancy (`userId`) and
 * policy (`defaultPolicy`, `status`) never come from the body, and an unknown key is a 400
 * `request.invalid`, not something silently ignored.
 */

export const INTEGRATION_NAME_MAX_LENGTH = 80;

/** What the user calls the source ("Work laptop"). Trimmed, 1 to 80 characters. */
export const integrationNameSchema = z.string().trim().min(1).max(INTEGRATION_NAME_MAX_LENGTH);

/**
 * An `http` source answers with its ingest key. A `browser-extension` source answers with no
 * key: its key is issued once, when the extension redeems a pairing code (`POST /v1/pair`), so
 * the dashboard never shows a key for the user to copy by hand.
 */
export const createIntegrationRequestSchema = z.strictObject({
  kind: z.enum(["http", "browser-extension"]),
  name: integrationNameSchema,
});
export type CreateIntegrationRequest = z.output<typeof createIntegrationRequestSchema>;

export const renameIntegrationRequestSchema = z.strictObject({
  name: integrationNameSchema,
});
export type RenameIntegrationRequest = z.output<typeof renameIntegrationRequestSchema>;

/**
 * An integration as the API returns it. It never carries a key or a hash. A new source starts as
 * `deny` (invariant 1); the policy is changed by rules, not by this resource.
 */
export const integrationSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["browser-extension", "http"]),
  name: z.string(),
  defaultPolicy: z.enum(["deny", "allow"]),
  status: z.enum(["active", "revoked"]),
  lastSeenAt: utcDateTimeSchema.nullable(),
  createdAt: utcDateTimeSchema,
});
export type Integration = z.output<typeof integrationSchema>;

export const integrationResponseSchema = z.strictObject({ integration: integrationSchema });
export type IntegrationResponse = z.output<typeof integrationResponseSchema>;

export const integrationListResponseSchema = z.strictObject({
  integrations: z.array(integrationSchema),
});
export type IntegrationListResponse = z.output<typeof integrationListResponseSchema>;

/**
 * The ingest key as shown once, in the create response only. `key` is the plaintext
 * (`pa_ing_...`); the server stores its SHA-256 hash and the display `prefix`.
 */
export const createdIngestKeySchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  prefix: z.string(),
});
export type CreatedIngestKey = z.output<typeof createdIngestKeySchema>;

/** The response for an `http` integration. A `browser-extension` one answers with `integrationResponseSchema`. */
export const createIntegrationResponseSchema = z.strictObject({
  integration: integrationSchema,
  ingestKey: createdIngestKeySchema,
});
export type CreateIntegrationResponse = z.output<typeof createIntegrationResponseSchema>;

/** Code of the 404 for an unknown, foreign or malformed integration id (all look the same). */
export const INTEGRATION_NOT_FOUND_CODE = "integration.not_found";
