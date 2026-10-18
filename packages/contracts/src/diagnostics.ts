import { z } from "zod";
import { heartbeatRequestSchema } from "./ingest.js";
import { utcDateTimeSchema } from "./primitives.js";

/**
 * Diagnostics DTO for the dashboard Health page (PLAN §6, `GET /v1/diagnostics`). Counters and
 * client-reported queue health only: no payloads, domains or URLs (invariant 2). The request is
 * strict, so tenancy never comes from the query.
 */

export const DIAGNOSTICS_DEFAULT_HOURS = 24;
export const DIAGNOSTICS_MAX_HOURS = 168;

const hoursSchema = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(DIAGNOSTICS_MAX_HOURS));

/** `hours` is the length of the ingestion window, ending with the current hour. */
export const diagnosticsQuerySchema = z.strictObject({
  hours: hoursSchema.optional(),
});
export type DiagnosticsQuery = z.output<typeof diagnosticsQuerySchema>;

/** What a source last reported about itself. Null until its first heartbeat. */
export const diagnosticsHeartbeatSchema = heartbeatRequestSchema;

export const diagnosticsIntegrationSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(["browser-extension", "http"]),
  status: z.enum(["active", "revoked"]),
  lastSeenAt: utcDateTimeSchema.nullable(),
  heartbeat: diagnosticsHeartbeatSchema.nullable(),
});
export type DiagnosticsIntegration = z.output<typeof diagnosticsIntegrationSchema>;

/** One hour of ingestion counters, summed over the user's sources. Hours with no traffic are zeros. */
export const diagnosticsBucketSchema = z.strictObject({
  bucket: utcDateTimeSchema,
  accepted: z.number().int().min(0),
  duplicate: z.number().int().min(0),
  dropped: z.number().int().min(0),
  rejected: z.number().int().min(0),
});
export type DiagnosticsBucket = z.output<typeof diagnosticsBucketSchema>;

/**
 * Events refused over the window, counted by what decided: a rule id, or the integration's default
 * policy when no rule did. Counters only (invariant 2). A rule that has since been deleted still
 * appears here; the dashboard shows the ones it knows.
 */
export const diagnosticsDropsSchema = z.strictObject({
  byRule: z.record(z.uuid(), z.int().min(0)),
  defaultPolicy: z.int().min(0),
});
export type DiagnosticsDrops = z.output<typeof diagnosticsDropsSchema>;

export const diagnosticsResponseSchema = z.strictObject({
  integrations: z.array(diagnosticsIntegrationSchema),
  /** Oldest hour first, one entry per hour of the window. */
  ingestion: z.array(diagnosticsBucketSchema),
  drops: diagnosticsDropsSchema,
});
export type DiagnosticsResponse = z.output<typeof diagnosticsResponseSchema>;
