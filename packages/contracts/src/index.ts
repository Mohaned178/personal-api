/**
 * @personal-api/contracts: Zod schemas shared by the API, the extension and the dashboard.
 * A new event type, DTO or format starts here, and both sides import it.
 */
export * from "./account.js";
export * from "./activity.js";
export * from "./blocking.js";
export * from "./browser-events.js";
export * from "./deletions.js";
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
export * from "./exports.js";
export * from "./ingest.js";
export * from "./ingest-config.js";
export * from "./integrations.js";
export * from "./limits.js";
export * from "./pairing.js";
export * from "./parse-event.js";
export * from "./primitives.js";
export * from "./recommendations.js";
export * from "./registry.js";
export * from "./retention.js";
export * from "./rule-fields.js";
export * from "./rule-glob.js";
export * from "./rule-presets.js";
export * from "./rule-trace.js";
export * from "./rules.js";
export * from "./rules-api.js";
export * from "./security.js";
export * from "./settings.js";
export * from "./setup.js";
