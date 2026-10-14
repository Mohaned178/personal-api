import { describe, expect, it } from "vitest";
import { ingestBatchRequestSchema, ingestItemResultSchema } from "./index.js";
import { pageVisited, UUID_V7 } from "./test-helpers.js";

function batchOf(count: number): { events: Record<string, unknown>[] } {
  return { events: Array.from({ length: count }, () => pageVisited()) };
}

describe("ingestBatchRequestSchema", () => {
  it("accepts a batch with one event", () => {
    expect(ingestBatchRequestSchema.safeParse(batchOf(1)).success).toBe(true);
  });

  it("accepts a batch of exactly 100 events (the limit is inclusive)", () => {
    expect(ingestBatchRequestSchema.safeParse(batchOf(100)).success).toBe(true);
  });

  it("rejects a batch of 101 events", () => {
    expect(ingestBatchRequestSchema.safeParse(batchOf(101)).success).toBe(false);
  });

  it("rejects a batch of 10,000 events", () => {
    expect(ingestBatchRequestSchema.safeParse(batchOf(10_000)).success).toBe(false);
  });

  it("rejects a request with no events key", () => {
    expect(ingestBatchRequestSchema.safeParse({}).success).toBe(false);
  });

  it.each([
    ["an object", { a: 1 }],
    ["a string", "events"],
    ["null", null],
    ["a number", 3],
  ])("rejects events given as %s", (_name, events) => {
    expect(ingestBatchRequestSchema.safeParse({ events }).success).toBe(false);
  });

  it.each([
    ["null", null],
    ["a string", "x"],
    ["an array", []],
    ["a number", 7],
  ])("rejects a request body that is %s", (_name, body) => {
    expect(ingestBatchRequestSchema.safeParse(body).success).toBe(false);
  });

  it.each(["userId", "integrationId", "receivedAt", "origin", "somethingElse"])(
    "rejects an unknown top-level key (%s): tenancy never comes from the request body",
    (key) => {
      expect(ingestBatchRequestSchema.safeParse({ ...batchOf(1), [key]: "x" }).success).toBe(false);
    },
  );

  it("accepts a batch that contains a malformed item, so the item can be rejected on its own", () => {
    // Per-item results (M1-05): one bad event must not fail the whole batch, so the request
    // schema checks the batch shape and the size limit only. parseEvent() validates each item.
    const body = { events: [pageVisited(), { id: "not-a-uuid" }, null, "garbage", 42] };
    expect(ingestBatchRequestSchema.safeParse(body).success).toBe(true);
  });
});

describe("ingestItemResultSchema", () => {
  it.each([
    ["accepted", { id: UUID_V7, status: "accepted" }],
    ["duplicate", { id: UUID_V7, status: "duplicate" }],
    ["dropped", { id: UUID_V7, status: "dropped" }],
    ["rejected with a code", { id: UUID_V7, status: "rejected", code: "ingest.payload_invalid" }],
  ])("accepts a %s result", (_name, item) => {
    expect(ingestItemResultSchema.safeParse(item).success).toBe(true);
  });

  it.each([
    "ingest.envelope_invalid",
    "ingest.type_unknown",
    "ingest.type_version_unknown",
    "ingest.payload_invalid",
  ])("accepts a rejected result carrying the stable code %s", (code) => {
    expect(
      ingestItemResultSchema.safeParse({ id: UUID_V7, status: "rejected", code }).success,
    ).toBe(true);
  });

  it("accepts a rejected result with no id (an event with a malformed id has none to echo)", () => {
    expect(
      ingestItemResultSchema.safeParse({ status: "rejected", code: "ingest.envelope_invalid" })
        .success,
    ).toBe(true);
  });

  it("rejects a rejected result without a code", () => {
    expect(ingestItemResultSchema.safeParse({ id: UUID_V7, status: "rejected" }).success).toBe(
      false,
    );
  });

  it.each([["stored"], ["ok"], ["Accepted"], [""], [null], [1]])(
    "rejects the unknown status %j",
    (status) => {
      expect(ingestItemResultSchema.safeParse({ id: UUID_V7, status }).success).toBe(false);
    },
  );

  it("rejects a result with no status", () => {
    expect(ingestItemResultSchema.safeParse({ id: UUID_V7 }).success).toBe(false);
  });

  it.each([
    ["null", null],
    ["a string", "accepted"],
    ["an array", []],
  ])("rejects a result that is %s", (_name, item) => {
    expect(ingestItemResultSchema.safeParse(item).success).toBe(false);
  });

  it("never carries the event payload: a result with a data key is rejected", () => {
    expect(
      ingestItemResultSchema.safeParse({
        id: UUID_V7,
        status: "dropped",
        data: { domain: "github.com", path: "/a" },
      }).success,
    ).toBe(false);
  });
});
