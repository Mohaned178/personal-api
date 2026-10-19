/**
 * @personal-api/contracts: Zod schemas shared by the API, the extension and the dashboard.
 * A new event type, DTO or format starts here, and both sides import it.
 */
export * from "./activity.js";
export * from "./browser-events.js";
export * from "./diagnostics.js";
export * from "./envelope.js";
export {
  type ContractIssue,
  INGEST_ERROR_CODES,
  type IngestErrorCode,
  ingestErrorCodeSchema,
  toContractIssues,
} from "./errors.js";
export * from "./events.js";
export * from "./ingest.js";
export * from "./ingest-config.js";
export * from "./integrations.js";
export * from "./pairing.js";
export * from "./parse-event.js";
export * from "./primitives.js";
export * from "./read-keys.js";
export * from "./registry.js";
export * from "./rule-fields.js";
export * from "./rule-glob.js";
export * from "./rule-trace.js";
export * from "./rules.js";
export * from "./rules-api.js";
export * from "./settings.js";
export * from "./setup.js";
