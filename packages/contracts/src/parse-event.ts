import { eventEnvelopeSchema, isPlainObject } from "./envelope.js";
import { type ContractIssue, type IngestErrorCode, toContractIssues } from "./errors.js";
import { EVENT_TYPES, eventTypeKey, getEventDataSchema, type KnownEvent } from "./registry.js";

export type ParseEventResult =
  | { ok: true; event: KnownEvent }
  | { ok: false; code: IngestErrorCode; issues: ContractIssue[] };

function fail(code: IngestErrorCode, issues: ContractIssue[]): ParseEventResult {
  return { ok: false, code, issues };
}

/**
 * Validates one incoming event. Never throws: any failure, including an input that throws while
 * being read, is reported as a result with a stable code (fail closed). Checks run in order and
 * the first failing stage decides the code:
 *
 * 1. `ingest.envelope_invalid`: not an object, an unknown or missing envelope key, a bad field.
 * 2. `ingest.type_unknown`: `type` is not registered.
 * 3. `ingest.type_version_unknown`: `type` is registered, but not at `typeVersion`.
 * 4. `ingest.payload_invalid`: `data` does not match the schema for `type@typeVersion`.
 *
 * Issues never contain the rejected values. The input is not mutated; the returned event is a
 * new object.
 */
export function parseEvent(input: unknown): ParseEventResult {
  try {
    if (!isPlainObject(input)) {
      return fail("ingest.envelope_invalid", [{ path: [], message: "Expected an object" }]);
    }

    const envelope = eventEnvelopeSchema.safeParse(input);
    if (!envelope.success) {
      return fail("ingest.envelope_invalid", toContractIssues(envelope.error.issues));
    }
    const { type, typeVersion, data } = envelope.data;

    const dataSchema = getEventDataSchema(eventTypeKey(type, typeVersion));
    if (dataSchema === undefined) {
      return EVENT_TYPES.has(type)
        ? fail("ingest.type_version_unknown", [
            { path: ["typeVersion"], message: "Unknown version for this event type" },
          ])
        : fail("ingest.type_unknown", [{ path: ["type"], message: "Unknown event type" }]);
    }

    const payload = dataSchema.safeParse(data);
    if (!payload.success) {
      return fail("ingest.payload_invalid", toContractIssues(payload.error.issues, ["data"]));
    }

    return { ok: true, event: { ...envelope.data, data: payload.data } as KnownEvent };
  } catch {
    return fail("ingest.envelope_invalid", [{ path: [], message: "The event could not be read" }]);
  }
}
