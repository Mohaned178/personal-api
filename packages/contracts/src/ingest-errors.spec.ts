import { describe, expect, it } from "vitest";
import {
  INGEST_ERROR_CODES,
  ingestBatchResponseSchema,
  ingestErrorCodeSchema,
  ingestItemResultSchema,
  parseEvent,
} from "./index.js";
import { pageVisited, UUID_V7 } from "./test-helpers.js";

// M1-05 adds one per-item code. The age window needs the server clock, so parseEvent() itself
// stays pure and never returns it; the ingest route does.
const TOO_OLD = "ingest.occurred_at_too_old";

describe("ingest.occurred_at_too_old (M1-05)", () => {
  it("is one of the stable ingest error codes", () => {
    expect(INGEST_ERROR_CODES).toContain(TOO_OLD);
  });

  it("keeps the four M1-01 codes unchanged", () => {
    expect(INGEST_ERROR_CODES).toEqual(
      expect.arrayContaining([
        "ingest.envelope_invalid",
        "ingest.type_unknown",
        "ingest.type_version_unknown",
        "ingest.payload_invalid",
      ]),
    );
  });

  it("is accepted by ingestErrorCodeSchema", () => {
    expect(ingestErrorCodeSchema.safeParse(TOO_OLD).success).toBe(true);
  });

  it("is accepted on a rejected per-item result", () => {
    expect(
      ingestItemResultSchema.safeParse({ id: UUID_V7, status: "rejected", code: TOO_OLD }).success,
    ).toBe(true);
  });

  it("is accepted in a batch response", () => {
    const body = { results: [{ id: UUID_V7, status: "rejected", code: TOO_OLD }] };
    expect(ingestBatchResponseSchema.safeParse(body).success).toBe(true);
  });

  it("is not a code parseEvent() returns: a very old but well-formed event still parses", () => {
    const result = parseEvent(pageVisited({}, { occurredAt: "2001-01-01T00:00:00.000Z" }));
    expect(result.ok).toBe(true);
  });
});

describe("ingest.rule_error (M4-05)", () => {
  it("is a stable ingest error code, and parseEvent() never returns it", () => {
    expect(INGEST_ERROR_CODES).toContain("ingest.rule_error");
    expect(ingestErrorCodeSchema.safeParse("ingest.rule_error").success).toBe(true);
    const parsed = parseEvent({ nonsense: true });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).not.toBe("ingest.rule_error");
  });

  it("is accepted on a rejected per-item result", () => {
    expect(
      ingestItemResultSchema.safeParse({
        id: UUID_V7,
        status: "rejected",
        code: "ingest.rule_error",
      }).success,
    ).toBe(true);
  });
});
