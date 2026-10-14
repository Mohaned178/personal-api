/**
 * M1-05 whole-request failures and body limits for `POST /v1/ingest/events`. A request that fails
 * as a whole gets ONE application/problem+json (never per-item results), stores nothing, and never
 * echoes the input. The 256 KB limit applies to this route only: everything else stays at 100 KB.
 */
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LIMIT_BYTES,
  eventRows,
  expectResults,
  INGEST_LIMIT_BYTES,
  INGEST_PATH,
  type IngestHarness,
  PROBLEM_JSON,
  pageVisit,
  post,
  postEvents,
  startIngestHarness,
  statuses,
} from "../../../test/ingest-helpers";

let h: IngestHarness;

beforeAll(async () => {
  h = await startIngestHarness();
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.reset();
});

/** A JSON text of exactly `bytes` bytes: one event-shaped object padded with an unknown key. */
function bodyOfExactSize(bytes: number): string {
  const empty = JSON.stringify({ events: [{ pad: "" }] });
  const text = JSON.stringify({
    events: [{ pad: "x".repeat(bytes - Buffer.byteLength(empty)) }],
  });
  expect(Buffer.byteLength(text)).toBe(bytes);
  return text;
}

async function expectProblem(
  res: { status: number; headers: Record<string, unknown>; body: unknown; text: string },
  status: number,
  code?: string,
) {
  expect(res.status).toBe(status);
  expect(String(res.headers["content-type"])).toMatch(PROBLEM_JSON);
  expect(res.body).toMatchObject({ status });
  if (code) expect(res.body).toMatchObject({ code });
  expect(res.body).not.toHaveProperty("results");
  expect(await eventRows(h.testDb.pool)).toHaveLength(0);
}

describe("body size limits", () => {
  it("accepts a body of exactly 256 KB on the ingest route", async () => {
    const res = await post(h.app, h.a.ingestKey, bodyOfExactSize(INGEST_LIMIT_BYTES));
    const results = expectResults(res);
    // The padded item is not an event: it is rejected per item, which proves the body was read.
    expect(results).toEqual([{ status: "rejected", code: "ingest.envelope_invalid" }]);
  });

  it("accepts a 200 KB body on the ingest route (above the 100 KB default)", async () => {
    const res = await post(h.app, h.a.ingestKey, bodyOfExactSize(200 * 1024));
    expect(statuses(expectResults(res))).toEqual(["rejected"]);
  });

  it("refuses a body of 256 KB + 1 byte with 413 http.payload_too_large problem+json", async () => {
    const res = await post(h.app, h.a.ingestKey, bodyOfExactSize(INGEST_LIMIT_BYTES + 1));
    await expectProblem(res, 413, "http.payload_too_large");
  });

  it("refuses a 600 KB body with 413 http.payload_too_large", async () => {
    const res = await post(h.app, h.a.ingestKey, bodyOfExactSize(600 * 1024));
    await expectProblem(res, 413, "http.payload_too_large");
  });

  it("keeps the 100 KB limit on other routes (a 101 KB body to /probe/ingest is 413)", async () => {
    const res = await request(h.app.getHttpServer())
      .post("/probe/ingest")
      .set("Authorization", `Bearer ${h.a.ingestKey}`)
      .send({ pad: "x".repeat(DEFAULT_LIMIT_BYTES + 1024) });
    expect(res.status).toBe(413);
    expect(String(res.headers["content-type"])).toMatch(PROBLEM_JSON);
    expect(res.body).toMatchObject({ code: "http.payload_too_large" });
  });

  it("still serves a 99 KB body on other routes", async () => {
    const res = await request(h.app.getHttpServer())
      .post("/probe/ingest")
      .set("Authorization", `Bearer ${h.a.ingestKey}`)
      .send({ pad: "x".repeat(99 * 1024) });
    expect(res.status).toBeLessThan(300);
  });

  it("does not widen the limit for other paths under /v1/ingest", async () => {
    const res = await request(h.app.getHttpServer())
      .post("/v1/ingest/not-the-events-route")
      .set("Authorization", `Bearer ${h.a.ingestKey}`)
      .send({ pad: "x".repeat(150 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ code: "http.payload_too_large" });
  });

  it("does not widen the limit for a lookalike path prefix (/v1/ingest/events-archive)", async () => {
    const res = await request(h.app.getHttpServer())
      .post("/v1/ingest/events-archive")
      .set("Authorization", `Bearer ${h.a.ingestKey}`)
      .send({ pad: "x".repeat(150 * 1024) });
    expect(res.status).toBe(413);
  });

  it("does not widen the limit for a sub-path of the events route (/v1/ingest/events/extra)", async () => {
    const res = await request(h.app.getHttpServer())
      .post("/v1/ingest/events/extra")
      .set("Authorization", `Bearer ${h.a.ingestKey}`)
      .send({ pad: "x".repeat(150 * 1024) });
    expect(res.status).toBe(413);
  });
});

describe("whole-request validation: 400 ingest.batch_invalid", () => {
  const BATCH_INVALID = "ingest.batch_invalid";

  it("rejects an empty events array", async () => {
    await expectProblem(await postEvents(h.app, h.a.ingestKey, []), 400, BATCH_INVALID);
  });

  it("rejects more than 100 events and stores none of them", async () => {
    const events = Array.from({ length: 101 }, () => pageVisit());
    await expectProblem(await postEvents(h.app, h.a.ingestKey, events), 400, BATCH_INVALID);
  });

  it("accepts exactly 100 events (the limit is inclusive)", async () => {
    const events = Array.from({ length: 100 }, () => pageVisit());
    expect(statuses(expectResults(await postEvents(h.app, h.a.ingestKey, events)))).toHaveLength(
      100,
    );
  });

  it("rejects a missing events key", async () => {
    await expectProblem(await post(h.app, h.a.ingestKey, {}), 400, BATCH_INVALID);
  });

  it.each([
    ["null", null],
    ["an object", { a: 1 }],
    ["a string", "events"],
    ["a number", 3],
  ])("rejects events given as %s", async (_name, events) => {
    await expectProblem(await post(h.app, h.a.ingestKey, { events }), 400, BATCH_INVALID);
  });

  it("rejects a request body that is a bare array", async () => {
    await expectProblem(await post(h.app, h.a.ingestKey, [pageVisit()]), 400, BATCH_INVALID);
  });

  it("rejects a request without a body", async () => {
    const res = await request(h.app.getHttpServer())
      .post(INGEST_PATH)
      .set("Authorization", `Bearer ${h.a.ingestKey}`);
    await expectProblem(res, 400, BATCH_INVALID);
  });

  it.each([
    ["userId", () => h.b.userId],
    ["integrationId", () => h.b.integrationId],
    ["receivedAt", () => "2026-10-14T12:00:00.000Z"],
    ["somethingElse", () => 1],
  ])("rejects an unknown top-level key (%s) and stores nothing", async (key, value) => {
    // Values are read lazily: the harness only exists once beforeAll has run.
    const res = await post(h.app, h.a.ingestKey, { events: [pageVisit()], [key]: value() });
    await expectProblem(res, 400, BATCH_INVALID);
  });

  it("does not echo the input: no unknown key name, event field or value in the problem body", async () => {
    const res = await post(h.app, h.a.ingestKey, {
      events: [pageVisit({ data: { domain: "echo-check.example" } })],
      "sentinel-unknown-key-3f9a": "sentinel-value-3f9a",
    });
    await expectProblem(res, 400, "ingest.batch_invalid");
    expect(res.text).not.toMatch(/sentinel|echo-check/i);
  });

  it("is one problem document, not per-item results, even when the batch is also too large", async () => {
    const events = Array.from({ length: 101 }, () => ({ nope: true }));
    const res = await postEvents(h.app, h.a.ingestKey, events);
    await expectProblem(res, 400, "ingest.batch_invalid");
  });
});

describe("invalid JSON", () => {
  it("answers malformed JSON with 400 problem+json, without echoing any of it", async () => {
    const res = await post(h.app, h.a.ingestKey, '{"events": [sentinel-secret-9d2c, }');
    await expectProblem(res, 400);
    expect(res.text).not.toContain("sentinel-secret-9d2c");
  });

  it("answers a truncated JSON body with 400 problem+json", async () => {
    const res = await post(h.app, h.a.ingestKey, `{"events": [${JSON.stringify(pageVisit())}`);
    await expectProblem(res, 400);
  });

  it("answers a JSON literal body (null) with 400 problem+json and stores nothing", async () => {
    const res = await post(h.app, h.a.ingestKey, "null");
    await expectProblem(res, 400);
  });
});

describe("order of checks", () => {
  it("answers an invalid batch from an unauthenticated caller with 401, not 400 (the guard runs first)", async () => {
    const res = await post(h.app, undefined, { events: [] });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "auth.invalid_key" });
  });

  it("answers an unknown key with an invalid batch with 401, not 400", async () => {
    const res = await post(h.app, `pa_ing_${"A".repeat(43)}`, { events: [], userId: "x" });
    expect(res.status).toBe(401);
  });
});
