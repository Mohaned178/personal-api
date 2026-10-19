import { z } from "zod";
import { safeMessage } from "./errors.js";
import { EVENT_TYPES } from "./registry.js";
import { RULE_LIMITS } from "./rules.js";

/**
 * Retention policies (`/v1/retention`, session only). An event's `expires_at` is
 * `receivedAt + days`, where `days` comes from the first of: a `set_retention` rule, the policy for
 * its type, the policy for its source (integration), `RETENTION_DEFAULT_DAYS`. Requests are
 * strict: `userId` never comes from the body or the path.
 */

export const RETENTION_DEFAULT_DAYS = 90;
export const RETENTION_MIN_DAYS = 1;
/** The same ceiling as the `set_retention` rule action. */
export const RETENTION_MAX_DAYS = RULE_LIMITS.retentionDaysMax;

export const RETENTION_SCOPES = ["source", "type"] as const;
export const retentionScopeSchema = z.enum(RETENTION_SCOPES);
export type RetentionScope = z.output<typeof retentionScopeSchema>;

export const retentionDaysSchema = z.int().min(RETENTION_MIN_DAYS).max(RETENTION_MAX_DAYS);

/** A source policy names an integration id, a type policy a registered event type. */
export const retentionSourceTargetSchema = z.uuid().transform((id) => id.toLowerCase());
export const retentionTypeTargetSchema = z
  .string()
  .refine((type) => EVENT_TYPES.has(type), { message: safeMessage("Unknown event type") });

export function retentionTargetSchema(scope: RetentionScope) {
  return scope === "source" ? retentionSourceTargetSchema : retentionTypeTargetSchema;
}

/** `PUT /v1/retention/:scope/:target`. */
export const putRetentionRequestSchema = z.strictObject({ days: retentionDaysSchema });
export type PutRetentionRequest = z.output<typeof putRetentionRequestSchema>;

export const retentionPolicySchema = z.strictObject({
  scope: retentionScopeSchema,
  target: z.string(),
  days: retentionDaysSchema,
  updatedAt: z.iso.datetime(),
});
export type RetentionPolicy = z.output<typeof retentionPolicySchema>;

/** `GET /v1/retention`: the fixed default and every policy, type policies first, then by target. */
export const retentionResponseSchema = z.strictObject({
  defaultDays: z.literal(RETENTION_DEFAULT_DAYS),
  policies: z.array(retentionPolicySchema),
});
export type RetentionResponse = z.output<typeof retentionResponseSchema>;

export const RETENTION_TARGET_INVALID_CODE = "retention.target_invalid";
export const RETENTION_TARGET_NOT_FOUND_CODE = "retention.target_not_found";

/**
 * The days that apply to an event: `set_retention` days, else the type policy, else the source
 * policy, else the default. Pure, so the API and its tests agree.
 */
export function resolveRetentionDays(input: {
  rule: number | null;
  type: number | null;
  source: number | null;
}): number {
  return input.rule ?? input.type ?? input.source ?? RETENTION_DEFAULT_DAYS;
}
