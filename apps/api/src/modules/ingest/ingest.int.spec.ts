/**
 * M1-05 `POST /v1/ingest/events`: idempotency, per-item results, row mapping, the 90-day age
 * window, future-timestamp clamping and cross-tenant behavior. Real application against
 * Testcontainers (CI runs these; Docker may be off locally), two-user fixture, fake clock.
 *
 * Whole-request failures and body limits live in ingest-request.int.spec.ts; the ingestion_log,
 * atomicity and log-hygiene checks live in ingest-log.int.spec.ts.
 */
import { randomUUID } from "node:crypto";
import { ingestBatchResponseSchema } from "@personal-api/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DAY_MS,
  eventRows,
  expectResults,
  FIXED_NOW,
  FUTURE_SKEW_MS,
  focusSegment,
  INGEST_PATH,
  type IngestHarness,
  isoAt,
  logRows,
  MAX_AGE_MS,
  PROBLEM_JSON,
  pageVisit,
  post,
  postEvents,
  startIngestHarness,
  statuses,
  tally,
} from "../../../test/ingest-helpers";
import { IntegrationsService } from "../integrations/integrations.service";
import { ApiKeysService } from "../keys/api-keys.service";
import { generateApiKey, hashApiKey } from "../keys/key-generation";

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

describe("authentication (the guard runs before anything is stored)", () => {
  const body = () => ({ events: [pageVisit()] });

  async function expectRefused(res: {
    status: number;
    headers: Record<string, unknown>;
    body: unknown;
  }) {
    expect(res.status).toBe(401);
    expect(String(res.headers["content-type"])).toMatch(PROBLEM_JSON);
    expect(res.body).toMatchObject({ status: 401, code: "auth.invalid_key" });
    expect(await eventRows(h.testDb.pool)).toHaveLength(0);
  }

  it("rejects a request without an Authorization header with 401 auth.invalid_key", async () => {
    await expectRefused(await post(h.app, undefined, body()));
  });

  it("rejects a malformed bearer token with 401 auth.invalid_key", async () => {
    await expectRefused(await post(h.app, "not-a-key", body()));
  });

  it("rejects a well-formed but unknown ingest key with 401 auth.invalid_key", async () => {
    await expectRefused(await post(h.app, generateApiKey("ingest").plaintext, body()));
  });

  it("rejects a session cookie without an ingest key with 401 auth.invalid_key", async () => {
    const res = await request(h.app.getHttpServer())
      .post(INGEST_PATH)
      .set("Cookie", h.a.cookie)
      .send(body());
    await expectRefused(res);
  });

  it("rejects a real pa_read_ key with 401 auth.invalid_key (read keys cannot ingest)", async () => {
    const read = generateApiKey("read");
    await h.testDb.pool.query(
      "insert into api_keys (user_id, kind, prefix, hash) values ($1, 'read', $2, $3)",
      [h.a.userId, read.prefix, read.hash],
    );
    expect(hashApiKey(read.plaintext)).toBe(read.hash);
    await expectRefused(await post(h.app, read.plaintext, body()));
  });

  it("rejects a revoked ingest key on the very next request and stores nothing", async () => {
    const created = await h.app.get(ApiKeysService).createIngestKey(h.a.userId, h.a.integrationId);
    const before = await postEvents(h.app, created.key, [pageVisit()]);
    expect(expectResults(before)).toHaveLength(1);
    await h.testDb.pool.query("truncate events");

    expect(await h.app.get(ApiKeysService).revokeKey(h.a.userId, created.id)).toBe(true);
    await expectRefused(await post(h.app, created.key, body()));
  });

  it("rejects the key of a revoked integration with 401 auth.invalid_key", async () => {
    const svc = h.app.get(IntegrationsService);
    const { integration, ingestKey } = await svc.create(h.a.userId, {
      kind: "http",
      name: "to-revoke",
    });
    await svc.revoke(h.a.userId, integration.id);
    await expectRefused(await post(h.app, ingestKey.key, body()));
  });
});

describe("idempotency: at-least-once in, effectively-once stored", () => {
  it("stores one row per event when the same batch is sent 3 times", async () => {
    const events = [pageVisit(), pageVisit(), pageVisit()];
    const first = expectResults(await postEvents(h.app, h.a.ingestKey, events));
    const second = expectResults(await postEvents(h.app, h.a.ingestKey, events));
    const third = expectResults(await postEvents(h.app, h.a.ingestKey, events));

    expect(statuses(first)).toEqual(["accepted", "accepted", "accepted"]);
    expect(statuses(second)).toEqual(["duplicate", "duplicate", "duplicate"]);
    expect(statuses(third)).toEqual(["duplicate", "duplicate", "duplicate"]);
    expect(await eventRows(h.testDb.pool)).toHaveLength(3);
  });

  it("echoes each event's id in its result, in request order", async () => {
    const events = [pageVisit(), pageVisit(), pageVisit()];
    const results = expectResults(await postEvents(h.app, h.a.ingestKey, events));
    expect(results.map((r) => r.id)).toEqual(events.map((e) => e.id));
  });

  it("answers accepted then duplicate when the same id appears twice in one batch", async () => {
    const id = randomUUID();
    const results = expectResults(
      await postEvents(h.app, h.a.ingestKey, [pageVisit({ id }), pageVisit({ id })]),
    );
    expect(statuses(results)).toEqual(["accepted", "duplicate"]);
    expect(results.map((r) => r.id)).toEqual([id, id]);
    expect(await eventRows(h.testDb.pool)).toHaveLength(1);
  });

  it("keeps the first payload when the same id arrives again with different data", async () => {
    const id = randomUUID();
    await postEvents(h.app, h.a.ingestKey, [pageVisit({ id, data: { path: "/first" } })]);
    const again = expectResults(
      await postEvents(h.app, h.a.ingestKey, [pageVisit({ id, data: { path: "/second" } })]),
    );
    expect(statuses(again)).toEqual(["duplicate"]);
    const rows = await eventRows(h.testDb.pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({ path: "/first" });
  });

  it("treats an upper-case id as the same event as its lower-case form", async () => {
    const id = randomUUID();
    const first = expectResults(await postEvents(h.app, h.a.ingestKey, [pageVisit({ id })]));
    const second = expectResults(
      await postEvents(h.app, h.a.ingestKey, [pageVisit({ id: id.toUpperCase() })]),
    );
    expect(statuses(first)).toEqual(["accepted"]);
    expect(statuses(second)).toEqual(["duplicate"]);
    expect(second[0]?.id).toBe(id);
    const rows = await eventRows(h.testDb.pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.client_event_id).toBe(id);
  });

  it("does not burn an id by rejecting it: a corrected resend of a rejected event is accepted", async () => {
    const id = randomUUID();
    const bad = expectResults(
      await postEvents(h.app, h.a.ingestKey, [pageVisit({ id, data: { path: "/x?q=1" } })]),
    );
    expect(bad[0]).toMatchObject({ status: "rejected", code: "ingest.payload_invalid" });
    expect(await eventRows(h.testDb.pool)).toHaveLength(0);

    const fixed = expectResults(await postEvents(h.app, h.a.ingestKey, [pageVisit({ id })]));
    expect(statuses(fixed)).toEqual(["accepted"]);
    expect(await eventRows(h.testDb.pool)).toHaveLength(1);
  });

  it("decides accepted vs duplicate from the insert itself: parallel identical batches give exactly one accepted per id", async () => {
    const events = [pageVisit(), pageVisit(), pageVisit(), pageVisit(), pageVisit()];
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => postEvents(h.app, h.a.ingestKey, events)),
    );
    const all = responses.map(expectResults);
    for (const index of events.keys()) {
      const column = all.map((results) => results[index]?.status);
      expect(column.filter((s) => s === "accepted")).toHaveLength(1);
      expect(column.filter((s) => s === "duplicate")).toHaveLength(7);
    }
    expect(await eventRows(h.testDb.pool)).toHaveLength(5);
  });

  it("matches a reference model over a seeded random sequence of overlapping batches", async () => {
    // Deterministic PRNG so a failure is reproducible.
    let state = 0x2f6e2b1;
    const next = (n: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % n;
    };
    const pool = Array.from({ length: 6 }, () => randomUUID());
    const firstPath = new Map<string, string>();
    const seen = new Set<string>();
    let expectedAccepted = 0;
    let expectedDuplicate = 0;
    let expectedRejected = 0;

    for (let round = 0; round < 12; round++) {
      const events: Record<string, unknown>[] = [];
      const expected: string[] = [];
      const size = 1 + next(8);
      for (let i = 0; i < size; i++) {
        if (next(5) === 0) {
          events.push({ ...pageVisit(), type: "browser.nope" });
          expected.push("rejected");
          expectedRejected++;
          continue;
        }
        const id = pool[next(pool.length)] as string;
        const path = `/r${round}/i${i}`;
        events.push(pageVisit({ id, data: { path } }));
        if (seen.has(id)) {
          expected.push("duplicate");
          expectedDuplicate++;
        } else {
          seen.add(id);
          firstPath.set(id, path);
          expected.push("accepted");
          expectedAccepted++;
        }
      }
      const results = expectResults(await postEvents(h.app, h.a.ingestKey, events));
      expect(statuses(results), `round ${round}`).toEqual(expected);
    }

    const rows = await eventRows(h.testDb.pool);
    expect(rows).toHaveLength(seen.size);
    for (const row of rows) expect(row.data.path).toBe(firstPath.get(row.client_event_id));
    const log = await logRows(h.testDb.pool, h.a.userId);
    expect(log.reduce((n, r) => n + r.accepted, 0)).toBe(expectedAccepted);
    expect(log.reduce((n, r) => n + r.duplicate, 0)).toBe(expectedDuplicate);
    expect(log.reduce((n, r) => n + r.rejected, 0)).toBe(expectedRejected);
  });
});

describe("per-item results", () => {
  it("returns the right code for each invalid item, in request order, and stores only the valid ones", async () => {
    const okA = pageVisit();
    const okB = pageVisit();
    const tooOld = pageVisit({ occurredAt: isoAt(FIXED_NOW, -MAX_AGE_MS - DAY_MS) });
    const events = [
      okA, // 0 accepted
      pageVisit({ extra: { id: "not-a-uuid" } }), // 1 envelope_invalid (no id to echo)
      { ...pageVisit(), type: "browser.unknown_thing" }, // 2 type_unknown
      { ...pageVisit(), typeVersion: 99 }, // 3 type_version_unknown
      pageVisit({ data: { path: "/a?secret=1" } }), // 4 payload_invalid
      tooOld, // 5 occurred_at_too_old
      okB, // 6 accepted
    ];
    const res = await postEvents(h.app, h.a.ingestKey, events);
    expect(ingestBatchResponseSchema.safeParse(res.body).success).toBe(true);
    const results = expectResults(res);

    expect(results).toHaveLength(7);
    expect(results[0]).toEqual({ id: okA.id, status: "accepted" });
    expect(results[1]).toEqual({ status: "rejected", code: "ingest.envelope_invalid" });
    expect(results[2]).toMatchObject({ status: "rejected", code: "ingest.type_unknown" });
    expect(results[3]).toMatchObject({ status: "rejected", code: "ingest.type_version_unknown" });
    expect(results[4]).toMatchObject({ status: "rejected", code: "ingest.payload_invalid" });
    expect(results[5]).toMatchObject({ status: "rejected", code: "ingest.occurred_at_too_old" });
    expect(results[6]).toEqual({ id: okB.id, status: "accepted" });

    const rows = await eventRows(h.testDb.pool);
    expect(rows.map((r) => r.client_event_id).sort()).toEqual([okA.id, okB.id].sort());
  });

  it("echoes the event id on a rejection when the id itself was valid", async () => {
    const wrongType = pageVisit({ extra: { type: "browser.unknown_thing" } });
    const badPayload = pageVisit({ data: { domain: "UPPER.example" } });
    const old = pageVisit({ occurredAt: isoAt(FIXED_NOW, -MAX_AGE_MS - 1) });
    const results = expectResults(
      await postEvents(h.app, h.a.ingestKey, [wrongType, badPayload, old]),
    );
    expect(results.map((r) => r.id)).toEqual([wrongType.id, badPayload.id, old.id]);
  });

  it.each([
    ["null", null],
    ["a number", 42],
    ["a string", "event"],
    ["an array", []],
    ["an empty object", {}],
  ])("rejects an item that is %s with ingest.envelope_invalid and no id", async (_name, item) => {
    const results = expectResults(await postEvents(h.app, h.a.ingestKey, [item, pageVisit()]));
    expect(results[0]).toEqual({ status: "rejected", code: "ingest.envelope_invalid" });
    expect(results[1]?.status).toBe("accepted");
    expect(await eventRows(h.testDb.pool)).toHaveLength(1);
  });

  it.each([
    ["userId", () => h.b.userId],
    ["integrationId", () => h.b.integrationId],
    ["receivedAt", () => FIXED_NOW],
    ["origin", () => "derived"],
  ])("rejects an event that carries server-owned key %s and stores nothing", async (key, value) => {
    // Values are read lazily: the harness only exists once beforeAll has run.
    const results = expectResults(
      await postEvents(h.app, h.a.ingestKey, [pageVisit({ extra: { [key]: value() } })]),
    );
    expect(results[0]).toMatchObject({ status: "rejected", code: "ingest.envelope_invalid" });
    expect(await eventRows(h.testDb.pool)).toHaveLength(0);
  });

  it("answers 200 with every item rejected when nothing in the batch is valid", async () => {
    const results = expectResults(
      await postEvents(h.app, h.a.ingestKey, [{ nope: true }, { ...pageVisit(), type: "x.y" }]),
    );
    expect(statuses(results)).toEqual(["rejected", "rejected"]);
    expect(await eventRows(h.testDb.pool)).toHaveLength(0);
  });

  it("accepts a full batch of 100 events and keeps the results in request order", async () => {
    const events = Array.from({ length: 100 }, () => pageVisit());
    const results = expectResults(await postEvents(h.app, h.a.ingestKey, events));
    expect(results).toHaveLength(100);
    expect(results.map((r) => r.id)).toEqual(events.map((e) => e.id));
    expect(new Set(statuses(results))).toEqual(new Set(["accepted"]));
    expect(await eventRows(h.testDb.pool)).toHaveLength(100);
  });

  it("accepts both v1 event types that carry a time range in data", async () => {
    const results = expectResults(
      await postEvents(h.app, h.a.ingestKey, [pageVisit(), focusSegment()]),
    );
    expect(statuses(results)).toEqual(["accepted", "accepted"]);
    const types = (await eventRows(h.testDb.pool)).map((r) => r.type).sort();
    expect(types).toEqual(["browser.focus_segment", "browser.page_visited"]);
  });

  it("never returns dropped in M1: an event for a deny-by-default integration is still stored", async () => {
    const { rows } = await h.testDb.pool.query<{ default_policy: string }>(
      "select default_policy from integrations where id = $1",
      [h.a.integrationId],
    );
    expect(rows[0]?.default_policy).toBe("deny");

    const results = expectResults(await postEvents(h.app, h.a.ingestKey, [pageVisit()]));
    expect(statuses(results)).toEqual(["accepted"]);
    expect(await eventRows(h.testDb.pool)).toHaveLength(1);
    const log = await logRows(h.testDb.pool, h.a.userId);
    expect(log.reduce((n, r) => n + r.dropped, 0)).toBe(0);
  });

  it.each([
    ["a lone high surrogate", "/a\uD800b"],
    ["a lone low surrogate", "/a\uDC00b"],
    ["a reversed surrogate pair", "/a\uDC00\uD800b"],
    ["a trailing high surrogate", "/a\uD800"],
  ])(
    "rejects a path with %s per item (jsonb cannot store it) and still accepts its valid sibling",
    async (_name, path) => {
      const bad = pageVisit({ data: { path } });
      const ok = pageVisit();
      // Sent as JSON text with the \uXXXX escape, so the parsed body really holds the lone surrogate
      // (a raw UTF-8 body would turn it into U+FFFD before it reached the server).
      const text = JSON.stringify({ events: [bad, ok] });
      expect(text).toMatch(/\\ud[89a-f][0-9a-f]{2}/);
      const results = expectResults(await post(h.app, h.a.ingestKey, text));

      expect(results).toEqual([
        { id: bad.id, status: "rejected", code: "ingest.payload_invalid" },
        { id: ok.id, status: "accepted" },
      ]);
      const rows = await eventRows(h.testDb.pool);
      expect(rows.map((r) => r.client_event_id)).toEqual([ok.id]);
      const log = await logRows(h.testDb.pool, h.a.userId);
      expect(log.map((r) => [r.accepted, r.rejected, r.by_reason])).toEqual([
        [1, 1, { "ingest.payload_invalid": 1 }],
      ]);
    },
  );

  it("accepts and stores a path whose non-ASCII characters are well-formed (an astral character as a surrogate pair)", async () => {
    const path = "/café/中/\u{1F600}";
    const event = pageVisit({ data: { path } });
    const results = expectResults(
      await post(h.app, h.a.ingestKey, JSON.stringify({ events: [event] })),
    );
    expect(statuses(results)).toEqual(["accepted"]);
    const [row] = await eventRows(h.testDb.pool);
    expect(row?.data.path).toBe(path);
  });

  it("returns only a status, an id and a code: never the payload, domain or path", async () => {
    const res = await postEvents(h.app, h.a.ingestKey, [
      pageVisit({ data: { domain: "leaky-domain.example", path: "/leaky-path" } }),
      pageVisit({ data: { domain: "LEAKY-INVALID.example", path: "/leaky-invalid-path" } }),
    ]);
    expectResults(res);
    expect(JSON.stringify(res.body)).not.toMatch(/leaky/i);
  });
});

describe("stored row mapping", () => {
  it("writes the envelope into columns, with tenancy taken from the key", async () => {
    const event = pageVisit({ data: { transition: "typed" } });
    expectResults(await postEvents(h.app, h.a.ingestKey, [event]));

    const [row] = await eventRows(h.testDb.pool);
    expect(row).toBeDefined();
    expect(row?.user_id).toBe(h.a.userId);
    expect(row?.integration_id).toBe(h.a.integrationId);
    expect(row?.client_event_id).toBe(event.id);
    expect(row?.id).not.toBe(event.id); // the server assigns its own row id
    expect(row?.type).toBe("browser.page_visited");
    expect(row?.type_version).toBe(1);
    expect(row?.occurred_at.toISOString()).toBe(event.occurredAt);
    expect(row?.client_occurred_at).toBeNull();
    expect(row?.received_at.toISOString()).toBe(FIXED_NOW);
    expect(row?.origin).toBe("collected");
    expect(row?.data).toEqual(event.data);
    expect(row?.tags).toEqual([]);
    expect(row?.trace).toBeNull();
    expect(row?.expires_at).toBeNull();
  });

  it("takes receivedAt from the server clock, not from the client", async () => {
    h.clock.set("2026-10-14T15:30:00.000Z");
    expectResults(
      await postEvents(h.app, h.a.ingestKey, [
        pageVisit({ occurredAt: "2026-10-14T15:00:00.000Z" }),
      ]),
    );
    const [row] = await eventRows(h.testDb.pool);
    expect(row?.received_at.toISOString()).toBe("2026-10-14T15:30:00.000Z");
  });
});

describe("the 90-day age window (fixed until M6)", () => {
  it("accepts an event exactly 90 days old", async () => {
    const results = expectResults(
      await postEvents(h.app, h.a.ingestKey, [
        pageVisit({ occurredAt: isoAt(FIXED_NOW, -MAX_AGE_MS) }),
      ]),
    );
    expect(statuses(results)).toEqual(["accepted"]);
  });

  it("rejects an event 1 ms older than 90 days with ingest.occurred_at_too_old and stores nothing", async () => {
    const event = pageVisit({ occurredAt: isoAt(FIXED_NOW, -MAX_AGE_MS - 1) });
    const results = expectResults(await postEvents(h.app, h.a.ingestKey, [event]));
    expect(results).toEqual([
      { id: event.id, status: "rejected", code: "ingest.occurred_at_too_old" },
    ]);
    expect(await eventRows(h.testDb.pool)).toHaveLength(0);
  });

  it("measures the window from the server clock at request time", async () => {
    const occurredAt = isoAt(FIXED_NOW, -MAX_AGE_MS);
    const before = expectResults(
      await postEvents(h.app, h.a.ingestKey, [pageVisit({ occurredAt })]),
    );
    expect(statuses(before)).toEqual(["accepted"]);

    h.clock.advance(1);
    const after = expectResults(
      await postEvents(h.app, h.a.ingestKey, [pageVisit({ occurredAt })]),
    );
    expect(after[0]).toMatchObject({ status: "rejected", code: "ingest.occurred_at_too_old" });
  });

  it("reports ingest.payload_invalid, not too_old, for an old event whose payload is also invalid", async () => {
    const results = expectResults(
      await postEvents(h.app, h.a.ingestKey, [
        pageVisit({
          occurredAt: isoAt(FIXED_NOW, -MAX_AGE_MS - DAY_MS),
          data: { path: "no-slash" },
        }),
      ]),
    );
    expect(results[0]).toMatchObject({ status: "rejected", code: "ingest.payload_invalid" });
  });

  it("does not reject a retry of an old event as a duplicate: it is still rejected as too old", async () => {
    const event = pageVisit({ occurredAt: isoAt(FIXED_NOW, -MAX_AGE_MS - DAY_MS) });
    const first = expectResults(await postEvents(h.app, h.a.ingestKey, [event]));
    const second = expectResults(await postEvents(h.app, h.a.ingestKey, [event]));
    expect(first[0]?.code).toBe("ingest.occurred_at_too_old");
    expect(second[0]?.code).toBe("ingest.occurred_at_too_old");
  });
});

describe("future-timestamp clamping", () => {
  it("keeps an event exactly 5 minutes ahead as sent", async () => {
    const occurredAt = isoAt(FIXED_NOW, FUTURE_SKEW_MS);
    expectResults(await postEvents(h.app, h.a.ingestKey, [pageVisit({ occurredAt })]));
    const [row] = await eventRows(h.testDb.pool);
    expect(row?.occurred_at.toISOString()).toBe(occurredAt);
    expect(row?.client_occurred_at).toBeNull();
  });

  it("clamps an event 5 minutes and 1 ms ahead to receivedAt and keeps the original", async () => {
    const occurredAt = isoAt(FIXED_NOW, FUTURE_SKEW_MS + 1);
    const results = expectResults(
      await postEvents(h.app, h.a.ingestKey, [pageVisit({ occurredAt })]),
    );
    expect(statuses(results)).toEqual(["accepted"]);
    const [row] = await eventRows(h.testDb.pool);
    expect(row?.occurred_at.toISOString()).toBe(FIXED_NOW);
    expect(row?.received_at.toISOString()).toBe(FIXED_NOW);
    expect(row?.client_occurred_at?.toISOString()).toBe(occurredAt);
  });

  it("clamps a far-future event (year 2999) instead of rejecting it", async () => {
    const occurredAt = "2999-01-01T00:00:00.000Z";
    const results = expectResults(
      await postEvents(h.app, h.a.ingestKey, [pageVisit({ occurredAt })]),
    );
    expect(statuses(results)).toEqual(["accepted"]);
    const [row] = await eventRows(h.testDb.pool);
    expect(row?.occurred_at.toISOString()).toBe(FIXED_NOW);
    expect(row?.client_occurred_at?.toISOString()).toBe(occurredAt);
  });

  it("clamps to the clock at request time", async () => {
    h.clock.set("2026-10-14T18:00:00.000Z");
    const occurredAt = "2026-10-14T19:00:00.000Z";
    expectResults(await postEvents(h.app, h.a.ingestKey, [pageVisit({ occurredAt })]));
    const [row] = await eventRows(h.testDb.pool);
    expect(row?.occurred_at.toISOString()).toBe("2026-10-14T18:00:00.000Z");
    expect(row?.client_occurred_at?.toISOString()).toBe(occurredAt);
  });

  it("leaves data untouched when it clamps occurredAt", async () => {
    const event = focusSegment({ occurredAt: isoAt(FIXED_NOW, DAY_MS) });
    expectResults(await postEvents(h.app, h.a.ingestKey, [event]));
    const [row] = await eventRows(h.testDb.pool);
    expect(row?.data).toEqual(event.data);
  });

  it("does not store a second row, or overwrite the flag, when a clamped event is resent", async () => {
    const event = pageVisit({ occurredAt: isoAt(FIXED_NOW, DAY_MS) });
    await postEvents(h.app, h.a.ingestKey, [event]);
    h.clock.advance(60_000);
    const again = expectResults(await postEvents(h.app, h.a.ingestKey, [event]));
    expect(statuses(again)).toEqual(["duplicate"]);
    const rows = await eventRows(h.testDb.pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurred_at.toISOString()).toBe(FIXED_NOW);
    expect(rows[0]?.client_occurred_at?.toISOString()).toBe(event.occurredAt);
  });

  it("applies the age check to the original value, so clamping never rescues an old event", async () => {
    const results = expectResults(
      await postEvents(h.app, h.a.ingestKey, [
        pageVisit({ occurredAt: isoAt(FIXED_NOW, -MAX_AGE_MS - 1) }),
        pageVisit({ occurredAt: isoAt(FIXED_NOW, FUTURE_SKEW_MS + 1) }),
      ]),
    );
    expect(statuses(results)).toEqual(["rejected", "accepted"]);
  });
});

describe("cross-tenant: a key only writes to its own integration", () => {
  it("stores user B's events under B's user and integration, never A's", async () => {
    const forB = pageVisit();
    expectResults(await postEvents(h.app, h.b.ingestKey, [forB]));
    const rows = await eventRows(h.testDb.pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: h.b.userId,
      integration_id: h.b.integrationId,
      client_event_id: forB.id,
    });
    expect(await eventRows(h.testDb.pool, h.a.userId)).toHaveLength(0);
  });

  it("ignores a userId or integrationId in the query string and in headers", async () => {
    const event = pageVisit();
    const res = await request(h.app.getHttpServer())
      .post(`${INGEST_PATH}?userId=${h.b.userId}&integrationId=${h.b.integrationId}`)
      .set("Authorization", `Bearer ${h.a.ingestKey}`)
      .set("X-User-Id", h.b.userId)
      .set("X-Integration-Id", h.b.integrationId)
      .send({ events: [event] });
    expect(statuses(expectResults(res))).toEqual(["accepted"]);
    const rows = await eventRows(h.testDb.pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: h.a.userId, integration_id: h.a.integrationId });
  });

  it("does not leak across tenants: B sending an id A already used is accepted, not a duplicate", async () => {
    const id = randomUUID();
    const forA = expectResults(await postEvents(h.app, h.a.ingestKey, [pageVisit({ id })]));
    const forB = expectResults(await postEvents(h.app, h.b.ingestKey, [pageVisit({ id })]));
    expect(statuses(forA)).toEqual(["accepted"]);
    expect(statuses(forB)).toEqual(["accepted"]);
    expect(await eventRows(h.testDb.pool, h.a.userId)).toHaveLength(1);
    expect(await eventRows(h.testDb.pool, h.b.userId)).toHaveLength(1);
  });

  it("dedupes per integration: the same id through a second integration of the same user is accepted", async () => {
    const second = await h.app
      .get(IntegrationsService)
      .create(h.a.userId, { kind: "http", name: "second-source" });
    const id = randomUUID();
    const viaFirst = expectResults(await postEvents(h.app, h.a.ingestKey, [pageVisit({ id })]));
    const viaSecond = expectResults(
      await postEvents(h.app, second.ingestKey.key, [pageVisit({ id })]),
    );
    expect(statuses(viaFirst)).toEqual(["accepted"]);
    expect(statuses(viaSecond)).toEqual(["accepted"]);
    const rows = await eventRows(h.testDb.pool, h.a.userId);
    expect(rows.map((r) => r.integration_id).sort()).toEqual(
      [h.a.integrationId, second.integration.id].sort(),
    );
  });

  it("keeps ingestion_log rows separate per user", async () => {
    await postEvents(h.app, h.a.ingestKey, [pageVisit(), pageVisit()]);
    await postEvents(h.app, h.b.ingestKey, [pageVisit()]);
    const a = await logRows(h.testDb.pool, h.a.userId);
    const b = await logRows(h.testDb.pool, h.b.userId);
    expect(a.map((r) => [r.integration_id, r.accepted])).toEqual([[h.a.integrationId, 2]]);
    expect(b.map((r) => [r.integration_id, r.accepted])).toEqual([[h.b.integrationId, 1]]);
  });

  it("tallies match what each caller was told", async () => {
    const mixed = [pageVisit(), { nope: 1 }];
    const t = tally(expectResults(await postEvents(h.app, h.b.ingestKey, mixed)));
    expect(t).toMatchObject({ accepted: 1, duplicate: 0, rejected: 1 });
    expect(await eventRows(h.testDb.pool, h.b.userId)).toHaveLength(1);
  });
});
