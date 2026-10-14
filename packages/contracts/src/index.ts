/**
 * @personal-api/contracts: Zod schemas shared by the API, the extension and the dashboard.
 * A new event type, DTO or format starts here, and both sides import it.
 */
export * from "./browser-events.js";
export * from "./envelope.js";
export {
  type ContractIssue,
  INGEST_ERROR_CODES,
  type IngestErrorCode,
  ingestErrorCodeSchema,
  toContractIssues,
} from "./errors.js";
export * from "./ingest.js";
export * from "./integrations.js";
export * from "./parse-event.js";
export * from "./primitives.js";
export * from "./registry.js";
