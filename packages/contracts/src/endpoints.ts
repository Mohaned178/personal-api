import { z } from "zod";
import { safeMessage } from "./errors.js";
import { utcDateTimeSchema } from "./primitives.js";
import { savedQueryDefinitionSchema, savedQueryResultSchema } from "./saved-query.js";

/**
 * User-defined endpoints (PLAN §6, `/v1/endpoints` and `GET /v1/me/:slug`). An endpoint is a slug
 * plus a saved query. Requests are strict: the owner, the id and the key never come from the body
 * (invariant 4). Each endpoint has read keys scoped to it (`endpoint:<id>`), minted by the server.
 */

/** Most endpoints one user can have. Creating more is a 409. */
export const ENDPOINTS_PER_USER_MAX = 50;

export const ENDPOINT_SLUG_MAX_LENGTH = 40;

/** Lowercase letters, digits and inner hyphens: safe in a path, never an identifier or a pattern. */
export const endpointSlugSchema = z
  .string()
  .min(1)
  .max(ENDPOINT_SLUG_MAX_LENGTH)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    safeMessage("Expected lowercase letters, digits and hyphens, not starting or ending with one"),
  );

/** 404 for an unknown, foreign, disabled-for-reading or malformed endpoint (all look the same). */
export const ENDPOINT_NOT_FOUND_CODE = "endpoint.not_found";
/** 409: the user already has an endpoint with this slug. */
export const ENDPOINT_SLUG_TAKEN_CODE = "endpoint.slug_taken";
export const ENDPOINT_LIMIT_REACHED_CODE = "endpoint.limit_reached";

/** `POST /v1/endpoints` and `PUT /v1/endpoints/:id` (a whole replacement). */
export const endpointInputSchema = z.strictObject({
  slug: endpointSlugSchema,
  enabled: z.boolean().default(true),
  definition: savedQueryDefinitionSchema,
});
export type EndpointInput = z.input<typeof endpointInputSchema>;
export type EndpointDefinitionInput = z.output<typeof endpointInputSchema>;

export const endpointSchema = z.strictObject({
  id: z.uuid(),
  slug: endpointSlugSchema,
  enabled: z.boolean(),
  definition: savedQueryDefinitionSchema,
  createdAt: utcDateTimeSchema,
  updatedAt: utcDateTimeSchema,
});
export type Endpoint = z.output<typeof endpointSchema>;

export const endpointResponseSchema = z.strictObject({ endpoint: endpointSchema });
export type EndpointResponse = z.output<typeof endpointResponseSchema>;

export const endpointListResponseSchema = z.strictObject({ endpoints: z.array(endpointSchema) });
export type EndpointListResponse = z.output<typeof endpointListResponseSchema>;

/** Create and rotate answer with the plaintext key, the only place it ever appears. */
export const endpointKeyResponseSchema = z.strictObject({
  endpoint: endpointSchema,
  key: z.string(),
});
export type EndpointKeyResponse = z.output<typeof endpointKeyResponseSchema>;

/** `POST /v1/endpoints/preview`: a dry run of an unsaved definition, with the same limits. Stores nothing. */
export const previewEndpointRequestSchema = z.strictObject({
  definition: savedQueryDefinitionSchema,
});
export type PreviewEndpointRequest = z.output<typeof previewEndpointRequestSchema>;

export const previewEndpointResponseSchema = z.strictObject({ result: savedQueryResultSchema });
export type PreviewEndpointResponse = z.output<typeof previewEndpointResponseSchema>;
