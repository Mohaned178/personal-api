import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseEvent } from "./index.js";
import { focusSegment, withoutKey } from "./test-helpers.js";

const PAYLOAD_INVALID = { ok: false, code: "ingest.payload_invalid" } as const;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;

function segment(startedAt: Date, durationMs: number): Record<string, unknown> {
  return focusSegment({
    startedAt: startedAt.toISOString(),
    endedAt: new Date(startedAt.getTime() + durationMs).toISOString(),
    durationMs,
  });
}

describe("browser.focus_segment v1", () => {
  it("accepts a segment whose durationMs matches endedAt minus startedAt", () => {
    expect(parseEvent(focusSegment()).ok).toBe(true);
  });

  it("accepts a zero-length segment (endedAt equals startedAt, durationMs 0)", () => {
    expect(
      parseEvent(
        focusSegment({
          startedAt: "2026-10-13T10:00:00.000Z",
          endedAt: "2026-10-13T10:00:00.000Z",
          durationMs: 0,
        }),
      ).ok,
    ).toBe(true);
  });

  it("accepts a segment of exactly 30 minutes (the cap is inclusive)", () => {
    expect(parseEvent(segment(new Date("2026-10-13T10:00:00.000Z"), THIRTY_MINUTES_MS)).ok).toBe(
      true,
    );
  });

  it("rejects a segment of 30 minutes and 1 ms with ingest.payload_invalid", () => {
    expect(
      parseEvent(segment(new Date("2026-10-13T10:00:00.000Z"), THIRTY_MINUTES_MS + 1)),
    ).toMatchObject(PAYLOAD_INVALID);
  });

  it("rejects a runaway multi-hour segment even when its timestamps are consistent", () => {
    expect(
      parseEvent(segment(new Date("2026-10-13T10:00:00.000Z"), 5 * 60 * 60 * 1000)),
    ).toMatchObject(PAYLOAD_INVALID);
  });

  it("rejects endedAt before startedAt with ingest.payload_invalid", () => {
    expect(
      parseEvent(
        focusSegment({
          startedAt: "2026-10-13T10:05:00.000Z",
          endedAt: "2026-10-13T10:00:00.000Z",
          durationMs: 300_000,
        }),
      ),
    ).toMatchObject(PAYLOAD_INVALID);
  });

  it("rejects endedAt before startedAt even when durationMs is negative and 'consistent'", () => {
    expect(
      parseEvent(
        focusSegment({
          startedAt: "2026-10-13T10:05:00.000Z",
          endedAt: "2026-10-13T10:00:00.000Z",
          durationMs: -300_000,
        }),
      ),
    ).toMatchObject(PAYLOAD_INVALID);
  });

  it.each([
    ["a negative durationMs", -1],
    ["a fractional durationMs", 300_000.5],
    ["a string durationMs", "300000"],
    ["a null durationMs", null],
  ])("rejects %s with ingest.payload_invalid", (_name, durationMs) => {
    expect(parseEvent(focusSegment({ durationMs }))).toMatchObject(PAYLOAD_INVALID);
  });

  it.each([
    ["5 s too long", 305_000],
    ["5 s too short", 295_000],
    ["1 ms too long", 300_001],
    ["1 ms too short", 299_999],
    ["zero", 0],
  ])(
    "rejects a durationMs that disagrees with the timestamps by %s with ingest.payload_invalid",
    (_name, durationMs) => {
      // timestamps span exactly 300000 ms
      expect(parseEvent(focusSegment({ durationMs }))).toMatchObject(PAYLOAD_INVALID);
    },
  );

  it.each(["domain", "path", "startedAt", "endedAt", "durationMs"])(
    "rejects data missing %s with ingest.payload_invalid",
    (field) => {
      const base = focusSegment();
      const data = withoutKey(base.data as Record<string, unknown>, field);
      expect(parseEvent({ ...base, data })).toMatchObject(PAYLOAD_INVALID);
    },
  );

  it.each([
    ["startedAt", "yesterday"],
    ["startedAt", "2026-10-13"],
    ["startedAt", 1_791_000_000_000],
    ["endedAt", "not a date"],
    ["endedAt", "2026-02-30T00:00:00.000Z"],
    ["endedAt", null],
  ])("rejects %s given as %j with ingest.payload_invalid", (field, value) => {
    expect(parseEvent(focusSegment({ [field]: value }))).toMatchObject(PAYLOAD_INVALID);
  });

  it.each([
    ["title", { title: "Inbox" }],
    ["url", { url: "https://github.com/a" }],
    ["tabRef", { tabRef: "k3j2h1g4f5d6a7b8" }],
    ["userId", { userId: "11111111-1111-4111-8111-111111111111" }],
    ["integrationId", { integrationId: "22222222-2222-4222-8222-222222222222" }],
    ["receivedAt", { receivedAt: "2026-10-13T10:05:01.000Z" }],
    ["origin", { origin: "collected" }],
  ])("rejects an unknown key in data (%s) with ingest.payload_invalid", (_name, extra) => {
    expect(parseEvent(focusSegment(extra))).toMatchObject(PAYLOAD_INVALID);
  });

  it("rejects a path with a query string or fragment with ingest.payload_invalid", () => {
    expect(parseEvent(focusSegment({ path: "/a?b=1" }))).toMatchObject(PAYLOAD_INVALID);
    expect(parseEvent(focusSegment({ path: "/a#b" }))).toMatchObject(PAYLOAD_INVALID);
  });

  it("rejects an upper-case domain with ingest.payload_invalid", () => {
    expect(parseEvent(focusSegment({ domain: "GitHub.com" }))).toMatchObject(PAYLOAD_INVALID);
  });

  it("rejects an unregistered typeVersion with ingest.type_version_unknown", () => {
    expect(parseEvent(focusSegment({}, { typeVersion: 2 }))).toMatchObject({
      ok: false,
      code: "ingest.type_version_unknown",
    });
  });
});

describe("browser.focus_segment v1: properties", () => {
  const startArb = fc.date({
    min: new Date("2020-01-01T00:00:00.000Z"),
    max: new Date("2100-01-01T00:00:00.000Z"),
    noInvalidDate: true,
  });

  it("accepts every segment with 0 <= durationMs <= 30 minutes and consistent timestamps", () => {
    fc.assert(
      fc.property(startArb, fc.integer({ min: 0, max: THIRTY_MINUTES_MS }), (start, durationMs) => {
        expect(parseEvent(segment(start, durationMs)).ok).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects every segment longer than 30 minutes", () => {
    fc.assert(
      fc.property(
        startArb,
        fc.integer({ min: THIRTY_MINUTES_MS + 1, max: 7 * 24 * 60 * 60 * 1000 }),
        (start, durationMs) => {
          expect(parseEvent(segment(start, durationMs))).toMatchObject(PAYLOAD_INVALID);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects every segment that ends before it starts", () => {
    fc.assert(
      fc.property(startArb, fc.integer({ min: 1, max: THIRTY_MINUTES_MS }), (start, back) => {
        const result = parseEvent(
          focusSegment({
            startedAt: start.toISOString(),
            endedAt: new Date(start.getTime() - back).toISOString(),
            durationMs: back,
          }),
        );
        expect(result).toMatchObject(PAYLOAD_INVALID);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects every segment whose durationMs disagrees with its timestamps", () => {
    fc.assert(
      fc.property(
        startArb,
        fc.integer({ min: 0, max: THIRTY_MINUTES_MS }),
        fc.integer({ min: 1, max: THIRTY_MINUTES_MS }),
        (start, durationMs, drift) => {
          const claimed = Math.min(durationMs + drift, THIRTY_MINUTES_MS);
          fc.pre(claimed !== durationMs);
          const base = segment(start, durationMs);
          const result = parseEvent({
            ...base,
            data: { ...(base.data as Record<string, unknown>), durationMs: claimed },
          });
          expect(result).toMatchObject(PAYLOAD_INVALID);
        },
      ),
      { numRuns: 200 },
    );
  });
});
