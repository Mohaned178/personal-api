import { z } from "zod";
import { createdIngestKeySchema, integrationSchema } from "./integrations.js";
import { utcDateTimeSchema } from "./primitives.js";

/**
 * Pairing DTOs (PLAN §6 and §7): the dashboard asks for a one-time code for a `browser-extension`
 * integration, and the extension exchanges it for an ingest key at `POST /v1/pair`. Requests are
 * strict: `userId` and `integrationId` never come from the body, they come from the code's row.
 */

/** A pairing code is valid for this long after it is issued. The dashboard counts down to it. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/** Unknown, expired, already used, superseded and revoked-integration codes all give this one error. */
export const PAIRING_CODE_INVALID_CODE = "pairing.code_invalid";

/** Too many `POST /v1/pair` attempts from one client. The `Retry-After` header says when to retry. */
export const PAIRING_RATE_LIMITED_CODE = "pairing.rate_limited";

/** The integration exists and is the caller's, but cannot be paired (revoked, or not an extension). */
export const PAIRING_NOT_PAIRABLE_CODE = "pairing.integration_not_pairable";

/**
 * What the extension sends. The code is shown as `XXXX-XXXX-XXXX-XXXX-XXXX`, but the server also
 * accepts it without dashes or in lower case, so the schema only bounds the length. The format is
 * checked by the server before it hashes anything.
 */
export const pairRequestSchema = z.strictObject({
  pairingCode: z.string().min(1).max(64),
});
export type PairRequest = z.output<typeof pairRequestSchema>;

/** The key is shown once. The integration is the one the code was issued for. */
export const pairResponseSchema = z.strictObject({
  integration: integrationSchema,
  ingestKey: createdIngestKeySchema,
});
export type PairResponse = z.output<typeof pairResponseSchema>;

/** Shown once, in the response that issues it. Only its SHA-256 hash is stored. */
export const pairingCodeResponseSchema = z.strictObject({
  pairingCode: z.string(),
  expiresAt: utcDateTimeSchema,
});
export type PairingCodeResponse = z.output<typeof pairingCodeResponseSchema>;
