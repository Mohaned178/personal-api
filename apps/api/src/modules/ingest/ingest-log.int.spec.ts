/**
 * M1-05 `ingestion_log` counters, atomicity and log hygiene for `POST /v1/ingest/events`.
 *
 * The hourly row is keyed (user, integration, bucket) with bucket = the server clock's hour (UTC).
 * Counters are accepted / duplicate / dropped / rejected, and `by_reason` counts rejected items by
 * error code only. The counters and the event insert share one transaction. Nothing sensitive
 * (payloads, URLs, domains, keys) is ever logged or stored in the log table.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { captureOutput } from "../../../test/auth.helpers";
import {
  DAY_MS,
  eventRows,
  expectResults,
  FIXED_NOW,
  type IngestHarness,
  isoAt,
  logRows,
  MAX_AGE_MS,
  PROBLEM_JSON,
  pageVisit,
  postEvents,
  SENTINEL_DOMAIN,
  SENTINEL_PATH,
  startIngestHarness,
  tally,
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

const bad = {
  payload: () => pageVisit({ data: { path: "/with?query=1" } }),
  type: () => ({ ...pageVisit(), type: "browser.unknown_thing" }),
  version: () => ({ ...pageVisit(), typeVersion: 42 }),
  envelope: () => ({ nope: true }),
  old: () => pageVisit({ occurredAt: isoAt(FIXED_NOW, -MAX_AGE_MS - DAY_MS) }),
};

describe("ingestion_log hourly upsert", () => {
  it("counts accepted, duplicate and rejected items to match the response, with by_reason keyed by error code", async () => {
    const seen = pageVisit();
    await postEvents(h.app, h.a.ingestKey, [seen]);
    await h.testDb.pool.query("truncate ingestion_log");

    const results = expectResults(
      await postEvents(h.app, h.a.ingestKey, [
        pageVisit(), // accepted
        seen, // duplicate
        bad.payload(),
        bad.payload(),
        bad.type(),
        bad.version(),
        bad.envelope(),
        bad.old(),
      ]),
    );
    expect(tally(results)).toMatchObject({ accepted: 1, duplicate: 1, rejected: 6 });

    const rows = await logRows(h.testDb.pool, h.a.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: h.a.userId,
      integration_id: h.a.integrationId,
      accepted: 1,
      duplicate: 1,
      dropped: 0,
      rejected: 6,
    });
    expect(rows[0]?.by_reason).toEqual({
      "ingest.payload_invalid": 2,
      "ingest.type_unknown": 1,
      "ingest.type_version_unknown": 1,
      "ingest.envelope_invalid": 1,
      "ingest.occurred_at_too_old": 1,
    });
  });

  it("leaves by_reason empty when nothing was rejected", async () => {
    await postEvents(h.app, h.a.ingestKey, [pageVisit(), pageVisit()]);
    const [row] = await logRows(h.testDb.pool, h.a.userId);
    expect(row).toMatchObject({ accepted: 2, duplicate: 0, dropped: 0, rejected: 0 });
    expect(row?.by_reason).toEqual({});
  });

  it("creates the row for a batch that was entirely rejected", async () => {
    expectResults(await postEvents(h.app, h.a.ingestKey, [bad.payload(), bad.envelope()]));
    const rows = await logRows(h.testDb.pool, h.a.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accepted: 0, duplicate: 0, dropped: 0, rejected: 2 });
    expect(rows[0]?.by_reason).toEqual({
      "ingest.payload_invalid": 1,
      "ingest.envelope_invalid": 1,
    });
  });

  it("counts duplicates when a whole batch is a resend", async () => {
    const events = [pageVisit(), pageVisit()];
    await postEvents(h.app, h.a.ingestKey, events);
    await postEvents(h.app, h.a.ingestKey, events);
    const rows = await logRows(h.testDb.pool, h.a.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accepted: 2, duplicate: 2, rejected: 0 });
  });

  it("adds to the same hourly row across requests and merges by_reason counts", async () => {
    await postEvents(h.app, h.a.ingestKey, [pageVisit(), bad.payload()]);
    h.clock.advance(10 * 60 * 1000);
    await postEvents(h.app, h.a.ingestKey, [pageVisit(), bad.payload(), bad.type()]);

    const rows = await logRows(h.testDb.pool, h.a.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accepted: 2, duplicate: 0, rejected: 3 });
    expect(rows[0]?.by_reason).toEqual({
      "ingest.payload_invalid": 2,
      "ingest.type_unknown": 1,
    });
  });

  it("buckets by the server clock's UTC hour, and starts a new row in the next hour", async () => {
    h.clock.set("2026-10-14T12:34:56.789Z");
    await postEvents(h.app, h.a.ingestKey, [pageVisit()]);
    h.clock.set("2026-10-14T13:00:00.000Z");
    await postEvents(h.app, h.a.ingestKey, [pageVisit(), pageVisit()]);

    const rows = await logRows(h.testDb.pool, h.a.userId);
    expect(rows.map((r) => [r.bucket.toISOString(), r.accepted])).toEqual([
      ["2026-10-14T12:00:00.000Z", 1],
      ["2026-10-14T13:00:00.000Z", 2],
    ]);
  });

  it("puts 12:59:59.999 in the 12:00 bucket", async () => {
    h.clock.set("2026-10-14T12:59:59.999Z");
    await postEvents(h.app, h.a.ingestKey, [pageVisit()]);
    const [row] = await logRows(h.testDb.pool, h.a.userId);
    expect(row?.bucket.toISOString()).toBe("2026-10-14T12:00:00.000Z");
  });

  it("keeps the totals in the log equal to the totals the client was told over many requests", async () => {
    const told: ReturnType<typeof expectResults> = [];
    const repeated = pageVisit();
    for (let round = 0; round < 4; round++) {
      h.clock.advance(round * 25 * 60 * 1000); // spans several hourly buckets
      told.push(
        ...expectResults(
          await postEvents(h.app, h.a.ingestKey, [
            pageVisit(),
            repeated,
            round % 2 === 0 ? bad.payload() : bad.old(),
          ]),
        ),
      );
    }
    const expected = tally(told);
    const rows = await logRows(h.testDb.pool, h.a.userId);
    const sum = (pick: (r: (typeof rows)[number]) => number) =>
      rows.reduce((n, r) => n + pick(r), 0);
    expect(sum((r) => r.accepted)).toBe(expected.accepted);
    expect(sum((r) => r.duplicate)).toBe(expected.duplicate);
    expect(sum((r) => r.rejected)).toBe(expected.rejected);
    expect(sum((r) => r.dropped)).toBe(0);

    const reasons: Record<string, number> = {};
    for (const row of rows) {
      for (const [code, n] of Object.entries(row.by_reason))
        reasons[code] = (reasons[code] ?? 0) + n;
    }
    expect(reasons).toEqual(expected.reasons);
    // And the rows the log says were accepted are the rows that exist.
    expect(await eventRows(h.testDb.pool)).toHaveLength(expected.accepted);
  });

  it("stays exact when identical batches race: the log shows one accepted per id and the rest duplicate", async () => {
    const events = [pageVisit(), pageVisit(), pageVisit()];
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => postEvents(h.app, h.a.ingestKey, events)),
    );
    responses.forEach(expectResults);
    const rows = await logRows(h.testDb.pool, h.a.userId);
    expect(rows.reduce((n, r) => n + r.accepted, 0)).toBe(3);
    expect(rows.reduce((n, r) => n + r.duplicate, 0)).toBe(15);
    expect(rows).toHaveLength(1);
  });

  it("holds no payload, URL, domain or key: the row is counters and error codes only", async () => {
    await postEvents(h.app, h.a.ingestKey, [
      pageVisit({ data: { domain: SENTINEL_DOMAIN, path: SENTINEL_PATH } }),
      pageVisit({ data: { domain: "UPPER-CASE.example", path: SENTINEL_PATH } }),
    ]);
    const { rows } = await h.testDb.pool.query<{ row: string }>(
      "select row_to_json(l)::text as row from ingestion_log l",
    );
    expect(rows).toHaveLength(1);
    const text = rows[0]?.row ?? "";
    expect(text).not.toContain("sentinel");
    expect(text).not.toContain(h.a.ingestKey);
    expect(text).not.toMatch(/example/i);
  });
});

describe("one transaction for the events and the counters", () => {
  async function withTrigger<T>(table: "events" | "ingestion_log", run: () => Promise<T>) {
    const pool = h.testDb.pool;
    await pool.query(
      `create or replace function pa_test_force_failure() returns trigger language plpgsql as
       $$ begin raise exception 'forced failure for test'; end $$`,
    );
    await pool.query(
      `create trigger pa_test_fail before insert or update on ${table}
       for each row execute function pa_test_force_failure()`,
    );
    try {
      return await run();
    } finally {
      await pool.query(`drop trigger if exists pa_test_fail on ${table}`);
    }
  }

  it("stores no event when the ingestion_log write fails, answers 500, and a retry then succeeds as accepted", async () => {
    const events = [pageVisit(), pageVisit()];
    const failed = await withTrigger("ingestion_log", () =>
      postEvents(h.app, h.a.ingestKey, events),
    );
    expect(failed.status).toBe(500);
    expect(String(failed.headers["content-type"])).toMatch(PROBLEM_JSON);
    expect(failed.body).toMatchObject({ status: 500, code: "internal.error" });
    expect(failed.text).not.toContain("forced failure");
    expect(await eventRows(h.testDb.pool)).toHaveLength(0);
    expect(await logRows(h.testDb.pool)).toHaveLength(0);

    const retried = expectResults(await postEvents(h.app, h.a.ingestKey, events));
    expect(retried.map((r) => r.status)).toEqual(["accepted", "accepted"]);
    expect(await eventRows(h.testDb.pool)).toHaveLength(2);
  });

  it("writes no counters when the event insert fails, and answers 500", async () => {
    const failed = await withTrigger("events", () =>
      postEvents(h.app, h.a.ingestKey, [pageVisit(), bad.payload()]),
    );
    expect(failed.status).toBe(500);
    expect(failed.body).toMatchObject({ code: "internal.error" });
    expect(await eventRows(h.testDb.pool)).toHaveLength(0);
    expect(await logRows(h.testDb.pool)).toHaveLength(0);
  });

  it("keeps the events and counters of earlier requests when a later request fails", async () => {
    await postEvents(h.app, h.a.ingestKey, [pageVisit()]);
    const failed = await withTrigger("events", () =>
      postEvents(h.app, h.a.ingestKey, [pageVisit()]),
    );
    expect(failed.status).toBe(500);
    const [row] = await logRows(h.testDb.pool, h.a.userId);
    expect(row).toMatchObject({ accepted: 1, duplicate: 0, rejected: 0 });
    expect(await eventRows(h.testDb.pool)).toHaveLength(1);
  });
});

describe("log hygiene (invariant 6)", () => {
  const BAD_KEY = `pa_ing_S3NTINEL${"A".repeat(35)}`;
  const sensitive = () => [
    "S3NTINEL",
    SENTINEL_DOMAIN,
    SENTINEL_PATH,
    "sentinel-path-7c1e",
    h.a.ingestKey,
    h.a.ingestKey.slice("pa_ing_".length),
  ];

  it("writes no payload, domain, path or key to the process output for accepted, duplicate and rejected items", async () => {
    const capture = captureOutput();
    try {
      const event = pageVisit({ data: { domain: SENTINEL_DOMAIN, path: SENTINEL_PATH } });
      const batch = await postEvents(h.app, h.a.ingestKey, [
        event,
        event,
        pageVisit({ data: { domain: SENTINEL_DOMAIN.toUpperCase(), path: SENTINEL_PATH } }),
        { ...pageVisit({ data: { domain: SENTINEL_DOMAIN, path: SENTINEL_PATH } }), type: "x.y" },
      ]);
      // Whole-request failures and auth failures with the same material.
      const empty = await postEvents(h.app, h.a.ingestKey, []);
      const refused = await postEvents(h.app, BAD_KEY, [event]);
      // Prove the requests really reached the route, so the output check cannot pass vacuously.
      expect(expectResults(batch).map((r) => r.status)).toEqual([
        "accepted",
        "duplicate",
        "rejected",
        "rejected",
      ]);
      expect(empty.status).toBe(400);
      expect(refused.status).toBe(401);
    } finally {
      const output = capture.stop();
      for (const secret of sensitive()) expect(output).not.toContain(secret);
    }
  });

  it("writes no payload, domain or key to the process output when the request fails with a 500", async () => {
    const capture = captureOutput();
    try {
      const pool = h.testDb.pool;
      await pool.query(
        `create or replace function pa_test_force_failure() returns trigger language plpgsql as
         $$ begin raise exception 'forced failure for test'; end $$`,
      );
      await pool.query(
        `create trigger pa_test_fail before insert on ingestion_log
         for each row execute function pa_test_force_failure()`,
      );
      try {
        const res = await postEvents(h.app, h.a.ingestKey, [
          pageVisit({ data: { domain: SENTINEL_DOMAIN, path: SENTINEL_PATH } }),
        ]);
        expect(res.status).toBe(500);
      } finally {
        await pool.query("drop trigger if exists pa_test_fail on ingestion_log");
      }
    } finally {
      const output = capture.stop();
      for (const secret of sensitive()) expect(output).not.toContain(secret);
    }
  });
});
