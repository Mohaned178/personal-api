import { z } from "zod";

/**
 * Stable error codes for a rejected event. Clients and the ingestion log key on these.
 *
 * `parseEvent()` returns the first four. `ingest.occurred_at_too_old` needs the server clock
 * (an event older than the accepted window), so only the ingest route returns it, and only for
 * an event that `parseEvent()` accepted.
 */
export const INGEST_ERROR_CODES = [
  "ingest.envelope_invalid",
  "ingest.type_unknown",
  "ingest.type_version_unknown",
  "ingest.payload_invalid",
  "ingest.occurred_at_too_old",
] as const;

export const ingestErrorCodeSchema = z.enum(INGEST_ERROR_CODES);
export type IngestErrorCode = z.output<typeof ingestErrorCodeSchema>;

/**
 * One validation problem. `path` points into the event (for example `["data", "path"]`).
 * `message` is generated from the schema only: it never contains the rejected value or an
 * unknown key's name, because those may be URLs, domains or other personal data.
 */
export interface ContractIssue {
  path: (string | number)[];
  message: string;
}

const safeMessages = new Set<string>();

/**
 * Registers a message written in this package (a fact about the schema, never about the input),
 * so `toContractIssues` may pass it through. Any other message is replaced by a generic one,
 * whatever a global Zod error map might produce.
 */
export function safeMessage(message: string): string {
  safeMessages.add(message);
  return message;
}

function describeIssue(issue: z.core.$ZodIssue): string {
  if (safeMessages.has(issue.message)) return issue.message;
  switch (issue.code) {
    case "invalid_type":
      return `Expected ${issue.expected}`;
    case "unrecognized_keys":
      return issue.keys.length === 1 ? "Unrecognized key" : "Unrecognized keys";
    case "too_big":
      return issue.origin === "string" || issue.origin === "array" ? "Too long" : "Too large";
    case "too_small":
      return issue.origin === "string" || issue.origin === "array" ? "Too short" : "Too small";
    case "invalid_value":
      return "Value is not one of the allowed options";
    case "invalid_format":
      return issue.format === "regex" ? "Invalid format" : `Invalid ${issue.format}`;
    case "not_multiple_of":
      return "Expected an integer";
    default:
      return "Invalid value";
  }
}

/** Converts Zod issues to `ContractIssue`s without echoing any input. */
export function toContractIssues(
  issues: readonly z.core.$ZodIssue[],
  prefix: (string | number)[] = [],
): ContractIssue[] {
  return issues.map((issue) => ({
    path: [
      ...prefix,
      ...issue.path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment)),
    ],
    message: describeIssue(issue),
  }));
}
