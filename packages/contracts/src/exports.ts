import { z } from "zod";
import { listEventsQuerySchema } from "./events.js";
import { utcDateTimeSchema } from "./primitives.js";

/**
 * Data export (PLAN §6, `/v1/exports`, session only). An export is a job: `POST` answers 202 with
 * an `export` the client polls at `GET /v1/exports/:id` until it is `completed` or `failed`. A
 * completed export is two files, downloaded from the API until `expiresAt`, then removed:
 *  - `events.ndjson.gz`: gzip of one JSON line per event, each a `storedEventSchema` object, newest
 *    first (`GET /v1/exports/:id/download`);
 *  - `manifest.json`: an `exportManifestSchema` object that describes the first file
 *    (`GET /v1/exports/:id/manifest`).
 * Requests are strict, and tenancy never comes from the body.
 */

export const EXPORT_NOT_FOUND_CODE = "export.not_found";
/** 409: the export has not completed (yet, or at all), so there is no file. */
export const EXPORT_NOT_READY_CODE = "export.not_ready";
/** 410: the download window has closed. */
export const EXPORT_EXPIRED_CODE = "export.expired";

/** How long a completed export can be downloaded. */
export const EXPORT_TTL_HOURS = 24;
/** The most recent exports `GET /v1/exports` lists. */
export const EXPORTS_LIST_LIMIT = 50;

export const EXPORT_EVENTS_FILE = "events.ndjson.gz";
export const EXPORT_MANIFEST_FILE = "manifest.json";
export const EXPORT_FORMAT = "personal-api-export";
export const EXPORT_FORMAT_VERSION = 1;

/** Which events to export: the list filter's fields. An empty filter exports everything. */
export const exportFilterSchema = z.strictObject(
  listEventsQuerySchema.pick({ source: true, type: true, from: true, to: true, domain: true })
    .shape,
);
export type ExportFilter = z.output<typeof exportFilterSchema>;

export const createExportRequestSchema = z.strictObject({ filter: exportFilterSchema.optional() });
export type CreateExportRequest = z.output<typeof createExportRequestSchema>;

export const EXPORT_STATUSES = ["queued", "running", "completed", "failed"] as const;

/** `eventCount` and `sizeBytes` are null until the job has finished; `expiresAt` too. */
export const exportSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(EXPORT_STATUSES),
  filter: exportFilterSchema,
  eventCount: z.number().int().min(0).nullable(),
  sizeBytes: z.number().int().min(0).nullable(),
  createdAt: utcDateTimeSchema,
  finishedAt: utcDateTimeSchema.nullable(),
  expiresAt: utcDateTimeSchema.nullable(),
});
export type Export = z.output<typeof exportSchema>;

export const exportResponseSchema = z.strictObject({ export: exportSchema });
export type ExportResponse = z.output<typeof exportResponseSchema>;

export const listExportsResponseSchema = z.strictObject({ exports: z.array(exportSchema) });
export type ListExportsResponse = z.output<typeof listExportsResponseSchema>;

/** The content of `manifest.json`. `file.sha256` is the hex digest of the gzip file's bytes. */
export const exportManifestSchema = z.strictObject({
  format: z.literal(EXPORT_FORMAT),
  formatVersion: z.literal(EXPORT_FORMAT_VERSION),
  exportId: z.uuid(),
  generatedAt: utcDateTimeSchema,
  filter: exportFilterSchema,
  eventCount: z.number().int().min(0),
  file: z.strictObject({
    name: z.literal(EXPORT_EVENTS_FILE),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().min(0),
  }),
});
export type ExportManifest = z.output<typeof exportManifestSchema>;
