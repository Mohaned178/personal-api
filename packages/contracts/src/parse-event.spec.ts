import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseEvent } from "./index.js";
import { OCCURRED_AT, pageVisited, UUID_V7, withoutKey } from "./test-helpers.js";

const ERROR_CODES = [
  "ingest.envelope_invalid",
  "ingest.type_unknown",
  "ingest.type_version_unknown",
  "ingest.payload_invalid",
];

describe("parseEvent: valid events", () => {
  it("accepts a valid browser.page_visited event and returns it with its fields intact", () => {
    const result = parseEvent(pageVisited());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.id).toBe(UUID_V7);
    expect(result.event.type).toBe("browser.page_visited");
    expect(result.event.typeVersion).toBe(1);
    expect(result.event.occurredAt).toBe(OCCURRED_AT);
    expect(result.event.data).toMatchObject({ domain: "github.com", path: "/Mohaned178/IdentiK" });
  });

  it("does not mutate the input object", () => {
    const input = pageVisited();
    const snapshot = structuredClone(input);
    parseEvent(input);
    expect(input).toEqual(snapshot);
  });

  it.each([
    ["v1", "6f9619ff-8b86-11d3-b4a1-00c04fd430c8"],
    ["v4", "f47ac10b-58cc-4372-a567-0e02b2c3d479"],
    ["v6", "1ef21d2f-1207-6660-8c4f-419efbd44d48"],
    ["v7", "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b"],
    ["v8", "320c3d4d-cc00-875b-8ec9-32d5f69181c0"],
    ["v7 in upper case", "0192F1C2-7C1E-7A3B-9F00-1C2D3E4F5A6B"],
  ])("accepts an RFC 9562 %s UUID as the envelope id", (_name, id) => {
    expect(parseEvent(pageVisited({}, { id })).ok).toBe(true);
  });
});

describe("parseEvent: ingest.envelope_invalid", () => {
  it.each([
    ["not-a-uuid"],
    [""],
    ["0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6"], // one character short
    ["0192f1c27c1e7a3b9f001c2d3e4f5a6b"], // no hyphens
    ["0192f1c2-7c1e-7a3b-1f00-1c2d3e4f5a6b"], // variant bits are not 10xx
    ["0192f1c2-7c1e-0a3b-9f00-1c2d3e4f5a6b"], // version 0 is not an RFC 9562 version
    ["0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b "], // trailing space
    [12345],
    [null],
  ])("rejects the envelope id %j with ingest.envelope_invalid", (id) => {
    expect(parseEvent(pageVisited({}, { id }))).toMatchObject({
      ok: false,
      code: "ingest.envelope_invalid",
    });
  });

  it.each(["id", "type", "typeVersion", "occurredAt"])(
    "rejects an event missing the envelope field %s with ingest.envelope_invalid",
    (field) => {
      expect(parseEvent(withoutKey(pageVisited(), field))).toMatchObject({
        ok: false,
        code: "ingest.envelope_invalid",
      });
    },
  );

  it("rejects an event with no data object (envelope or payload error, never accepted)", () => {
    const result = parseEvent(withoutKey(pageVisited(), "data"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["ingest.envelope_invalid", "ingest.payload_invalid"]).toContain(result.code);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "browser.page_visited"],
    ["a number", 42],
    ["an array", [pageVisited()]],
    ["a boolean", true],
  ])("rejects %s as the whole input with ingest.envelope_invalid", (_name, input) => {
    expect(parseEvent(input)).toMatchObject({ ok: false, code: "ingest.envelope_invalid" });
  });

  it.each([
    ["userId", { userId: "11111111-1111-4111-8111-111111111111" }],
    ["integrationId", { integrationId: "22222222-2222-4222-8222-222222222222" }],
    ["receivedAt", { receivedAt: "2026-10-13T10:05:01.000Z" }],
    ["origin", { origin: "imported" }],
    ["user_id", { user_id: "11111111-1111-4111-8111-111111111111" }],
    ["integration_id", { integration_id: "22222222-2222-4222-8222-222222222222" }],
    ["an arbitrary unknown key", { somethingElse: 1 }],
  ])("rejects an unknown envelope key (%s) with ingest.envelope_invalid", (_name, extra) => {
    expect(parseEvent(pageVisited({}, extra))).toMatchObject({
      ok: false,
      code: "ingest.envelope_invalid",
    });
  });

  it("rejects an own __proto__ key in the envelope (JSON-parsed pollution attempt)", () => {
    const input = JSON.parse(
      `{"id":"${UUID_V7}","type":"browser.page_visited","typeVersion":1,"occurredAt":"${OCCURRED_AT}","data":{"domain":"github.com","path":"/a","tabRef":"k3j2h1g4f5d6a7b8"},"__proto__":{"userId":"x"}}`,
    );
    expect(parseEvent(input)).toMatchObject({ ok: false, code: "ingest.envelope_invalid" });
  });

  it.each([
    ["0", 0],
    ["a negative number", -1],
    ["a fraction", 1.5],
    ["a string", "1"],
    ["null", null],
    ["NaN-like text", "NaN"],
  ])("rejects typeVersion %s with ingest.envelope_invalid", (_name, typeVersion) => {
    expect(parseEvent(pageVisited({}, { typeVersion }))).toMatchObject({
      ok: false,
      code: "ingest.envelope_invalid",
    });
  });

  it.each([
    ["an empty string", ""],
    ["a number", 7],
    ["null", null],
    ["an object", { name: "browser.page_visited" }],
  ])("rejects type %s with ingest.envelope_invalid", (_name, type) => {
    expect(parseEvent(pageVisited({}, { type }))).toMatchObject({
      ok: false,
      code: "ingest.envelope_invalid",
    });
  });

  it.each([
    ["a human date", "yesterday"],
    ["a date without a time", "2026-10-13"],
    ["a space instead of T", "2026-10-13 10:05:00.000Z"],
    ["an epoch number", 1_791_000_000_000],
    ["a day that does not exist", "2026-02-30T00:00:00.000Z"],
    ["an empty string", ""],
    ["null", null],
  ])("rejects occurredAt given as %s with ingest.envelope_invalid", (_name, occurredAt) => {
    expect(parseEvent(pageVisited({}, { occurredAt }))).toMatchObject({
      ok: false,
      code: "ingest.envelope_invalid",
    });
  });

  it.each([
    ["a string", "meta"],
    ["an array", []],
    ["null", null],
  ])("rejects meta given as %s with ingest.envelope_invalid", (_name, meta) => {
    expect(parseEvent(pageVisited({}, { meta }))).toMatchObject({
      ok: false,
      code: "ingest.envelope_invalid",
    });
  });
});

describe("parseEvent: ingest.type_unknown and ingest.type_version_unknown", () => {
  it.each([["browser.nope"], ["browser.page_visited.extra"], ["github.push"], ["x"]])(
    "rejects the unregistered type %s with ingest.type_unknown",
    (type) => {
      expect(parseEvent(pageVisited({}, { type }))).toMatchObject({
        ok: false,
        code: "ingest.type_unknown",
      });
    },
  );

  it("reports ingest.type_unknown (not payload_invalid) when the type is unknown and data is garbage", () => {
    expect(
      parseEvent(pageVisited({}, { type: "browser.nope", data: { whatever: 1 } })),
    ).toMatchObject({ ok: false, code: "ingest.type_unknown" });
  });

  it.each([2, 3, 99])(
    "rejects a known type at the unregistered version %i with ingest.type_version_unknown",
    (typeVersion) => {
      expect(parseEvent(pageVisited({}, { typeVersion }))).toMatchObject({
        ok: false,
        code: "ingest.type_version_unknown",
      });
    },
  );

  it("reports ingest.type_version_unknown (not payload_invalid) when the version is unknown and data is garbage", () => {
    expect(parseEvent(pageVisited({}, { typeVersion: 2, data: { whatever: 1 } }))).toMatchObject({
      ok: false,
      code: "ingest.type_version_unknown",
    });
  });
});

describe("parseEvent: ingest.payload_invalid", () => {
  it("rejects a known type and version whose data does not match with ingest.payload_invalid", () => {
    expect(parseEvent(pageVisited({ domain: "GitHub.com" }))).toMatchObject({
      ok: false,
      code: "ingest.payload_invalid",
    });
  });
});

describe("parseEvent: result contract", () => {
  it("returns a non-empty issues array on every failure", () => {
    const failures = [
      parseEvent(null),
      parseEvent(pageVisited({}, { userId: "x" })),
      parseEvent(pageVisited({}, { type: "browser.nope" })),
      parseEvent(pageVisited({}, { typeVersion: 2 })),
      parseEvent(pageVisited({ path: "/a?b=1" })),
    ];
    for (const result of failures) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(Array.isArray(result.issues)).toBe(true);
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it("does not echo rejected values back in the result (they may be URLs or domains)", () => {
    const result = parseEvent(pageVisited({ path: "/secret-sentinel-xyz?token=abc123" }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret-sentinel-xyz");
    expect(JSON.stringify(result)).not.toContain("abc123");
  });

  it("does not throw when reading the input throws, and fails closed with ingest.envelope_invalid", () => {
    const hostile = {
      get id(): string {
        throw new Error("boom");
      },
    };
    const run = () => parseEvent(hostile);
    expect(run).not.toThrow();
    expect(run()).toMatchObject({ ok: false, code: "ingest.envelope_invalid" });
  });

  it("never throws on arbitrary JSON and only ever returns one of the four stable codes", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (input) => {
        const result = parseEvent(input);
        if (result.ok) return;
        expect(ERROR_CODES).toContain(result.code);
      }),
      { numRuns: 300 },
    );
  });

  it("never accepts an event that carries a server-owned envelope key", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("userId", "integrationId", "receivedAt", "origin"),
        fc.jsonValue(),
        (key, value) => {
          expect(parseEvent(pageVisited({}, { [key]: value })).ok).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("never accepts an event that carries a server-owned key inside data", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("userId", "integrationId", "receivedAt", "origin"),
        fc.jsonValue(),
        (key, value) => {
          expect(parseEvent(pageVisited({ [key]: value })).ok).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
