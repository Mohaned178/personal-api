/**
 * M1-05 ingest decisions without a database: per-item planning (parse, age window, clamping,
 * repeats in one batch), results from the stored set, counters, the hourly bucket, and the
 * service's whole-request validation. The real insert and upsert are covered by *.int.spec.ts.
 */
import { randomUUID } from "node:crypto";
import { ingestBatchResponseSchema } from "@personal-api/contracts";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import { AppException } from "../../platform/errors/problem";
import type { IngestionCounts, IngestRepository, StoreBatchInput } from "./ingest.repository";
import {
  countResults,
  hourBucket,
  INGEST_MAX_EVENT_AGE_MS,
  INGEST_MAX_FUTURE_SKEW_MS,
  IngestService,
  type ItemPlan,
  planBatch,
  toResults,
} from "./ingest.service";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const USER = "user-1";
const INTEGRATION = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";

const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

function visit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    type: "browser.page_visited",
    typeVersion: 1,
    occurredAt: at(-60_000),
    data: { domain: "example.com", path: "/a", transition: "link", tabRef: "tab-ref-12345678" },
    ...overrides,
  };
}

const kinds = (plan: ItemPlan[]) => plan.map((item) => item.kind);

describe("planBatch", () => {
  it("rejects each invalid item with its parseEvent code, in request order", () => {
    const plan = planBatch(
      [
        visit(),
        { nope: true },
        visit({ type: "browser.unknown" }),
        visit({ typeVersion: 9 }),
        visit({ data: { domain: "example.com", path: "/a?q=1", tabRef: "tab-ref-12345678" } }),
      ],
      NOW,
    );
    expect(plan.map((item) => (item.kind === "rejected" ? item.code : item.kind))).toEqual([
      "store",
      "ingest.envelope_invalid",
      "ingest.type_unknown",
      "ingest.type_version_unknown",
      "ingest.payload_invalid",
    ]);
  });

  it("echoes a valid id on a rejection, lowercased, and none for a malformed one", () => {
    const id = randomUUID();
    const [wrongType, badId, notObject] = planBatch(
      [visit({ id: id.toUpperCase(), type: "x.y" }), visit({ id: "nope" }), null],
      NOW,
    );
    expect(wrongType).toEqual({ kind: "rejected", code: "ingest.type_unknown", id });
    expect(badId).toEqual({ kind: "rejected", code: "ingest.envelope_invalid" });
    expect(notObject).toEqual({ kind: "rejected", code: "ingest.envelope_invalid" });
  });

  it("accepts exactly 90 days old and rejects 1 ms older with ingest.occurred_at_too_old", () => {
    const old = visit({ occurredAt: at(-INGEST_MAX_EVENT_AGE_MS - 1) });
    const plan = planBatch([visit({ occurredAt: at(-INGEST_MAX_EVENT_AGE_MS) }), old], NOW);
    expect(plan[0]?.kind).toBe("store");
    expect(plan[1]).toEqual({ kind: "rejected", code: "ingest.occurred_at_too_old", id: old.id });
  });

  it("lets a parseEvent code win over the age check", () => {
    const [item] = planBatch(
      [
        visit({
          occurredAt: at(-INGEST_MAX_EVENT_AGE_MS - 86_400_000),
          data: { domain: "example.com", path: "no-slash", tabRef: "tab-ref-12345678" },
        }),
      ],
      NOW,
    );
    expect(item).toMatchObject({ kind: "rejected", code: "ingest.payload_invalid" });
  });

  it("keeps exactly 5 minutes ahead as sent and clamps 1 ms more to receivedAt", () => {
    const [kept, clamped] = planBatch(
      [
        visit({ occurredAt: at(INGEST_MAX_FUTURE_SKEW_MS) }),
        visit({ occurredAt: at(INGEST_MAX_FUTURE_SKEW_MS + 1) }),
      ],
      NOW,
    );
    expect(kept).toMatchObject({
      kind: "store",
      event: { occurredAt: new Date(at(INGEST_MAX_FUTURE_SKEW_MS)), clientOccurredAt: null },
    });
    expect(clamped).toMatchObject({
      kind: "store",
      event: {
        occurredAt: NOW,
        receivedAt: NOW,
        clientOccurredAt: new Date(at(INGEST_MAX_FUTURE_SKEW_MS + 1)),
      },
    });
  });

  it("maps the validated envelope to a row, with receivedAt from the given clock time", () => {
    const event = visit();
    const [item] = planBatch([event], NOW);
    expect(item).toEqual({
      kind: "store",
      event: {
        clientEventId: event.id,
        type: "browser.page_visited",
        typeVersion: 1,
        occurredAt: new Date(event.occurredAt as string),
        clientOccurredAt: null,
        receivedAt: NOW,
        data: event.data,
      },
    });
  });

  it("stores only the first valid copy of an id; later valid copies are repeats", () => {
    const id = randomUUID();
    const plan = planBatch(
      [visit({ id, type: "x.y" }), visit({ id }), visit({ id: id.toUpperCase() }), visit({ id })],
      NOW,
    );
    expect(kinds(plan)).toEqual(["rejected", "store", "repeat", "repeat"]);
  });

  it("never mutates its input", () => {
    const event = visit({ occurredAt: at(INGEST_MAX_FUTURE_SKEW_MS + 1) });
    const copy = structuredClone(event);
    planBatch([event], NOW);
    expect(event).toEqual(copy);
  });
});

describe("toResults", () => {
  it("answers accepted for stored ids, duplicate otherwise, and keeps request order", () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const plan = planBatch([visit({ id: a }), visit({ id: b }), visit({ id: a }), {}], NOW);
    expect(toResults(plan, new Set([a]))).toEqual([
      { id: a, status: "accepted" },
      { id: b, status: "duplicate" },
      { id: a, status: "duplicate" },
      { status: "rejected", code: "ingest.envelope_invalid" },
    ]);
  });

  it("never answers dropped, and always matches the strict response contract", () => {
    const plan = planBatch([visit(), visit({ type: "x.y" }), {}, 7], NOW);
    const results = toResults(plan, new Set());
    expect(results.map((r) => r.status)).not.toContain("dropped");
    expect(ingestBatchResponseSchema.safeParse({ results }).success).toBe(true);
  });
});

describe("countResults", () => {
  it("counts each status and keys rejections by error code", () => {
    expect(
      countResults([
        { id: INTEGRATION, status: "accepted" },
        { id: INTEGRATION, status: "duplicate" },
        { id: INTEGRATION, status: "duplicate" },
        { status: "rejected", code: "ingest.payload_invalid" },
        { status: "rejected", code: "ingest.payload_invalid" },
        { status: "rejected", code: "ingest.occurred_at_too_old" },
      ]),
    ).toEqual({
      accepted: 1,
      duplicate: 2,
      dropped: 0,
      rejected: 3,
      byReason: { "ingest.payload_invalid": 2, "ingest.occurred_at_too_old": 1 },
    });
  });

  it("leaves byReason empty when nothing was rejected", () => {
    expect(countResults([{ id: INTEGRATION, status: "accepted" }]).byReason).toEqual({});
  });
});

describe("hourBucket", () => {
  it.each([
    ["2026-10-14T12:00:00.000Z", "2026-10-14T12:00:00.000Z"],
    ["2026-10-14T12:34:56.789Z", "2026-10-14T12:00:00.000Z"],
    ["2026-10-14T12:59:59.999Z", "2026-10-14T12:00:00.000Z"],
    ["2026-10-14T23:59:59.999Z", "2026-10-14T23:00:00.000Z"],
  ])("puts %s in the %s bucket (UTC)", (time, bucket) => {
    expect(hourBucket(new Date(time)).toISOString()).toBe(bucket);
  });
});

describe("IngestService", () => {
  interface Call {
    userId: string;
    integrationId: string;
    batch: StoreBatchInput;
    counts: IngestionCounts;
  }

  /** Stores every id it has not seen before, like the real insert, and records each call. */
  function fakeRepository() {
    const seen = new Set<string>();
    const calls: Call[] = [];
    const repository = {
      async storeBatch(
        userId: string,
        integrationId: string,
        batch: StoreBatchInput,
        summarize: (stored: ReadonlySet<string>) => IngestionCounts,
      ) {
        const stored = new Set<string>();
        for (const event of batch.events) {
          if (!seen.has(event.clientEventId)) stored.add(event.clientEventId);
          seen.add(event.clientEventId);
        }
        calls.push({ userId, integrationId, batch, counts: summarize(stored) });
        return stored;
      },
    };
    return { repository: repository as unknown as IngestRepository, calls };
  }

  function service() {
    const clock = new FakeClock(NOW);
    const fake = fakeRepository();
    return { ...fake, clock, ingest: new IngestService(fake.repository, clock) };
  }

  it.each([
    ["no body", undefined],
    ["null", null],
    ["a bare array", [visit()]],
    ["no events key", {}],
    ["an empty events array", { events: [] }],
    ["101 events", { events: Array.from({ length: 101 }, () => visit()) }],
    ["an unknown top-level key", { events: [visit()], integrationId: INTEGRATION }],
  ])("refuses %s with one 400 ingest.batch_invalid and stores nothing", async (_name, body) => {
    const { ingest, calls } = service();
    const error = await ingest.ingestBatch(USER, INTEGRATION, body).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).getStatus()).toBe(400);
    expect((error as AppException).code).toBe("ingest.batch_invalid");
    expect(calls).toEqual([]);
  });

  it("does not echo the input in the batch_invalid problem", async () => {
    const { ingest } = service();
    const error = await ingest
      .ingestBatch(USER, INTEGRATION, {
        events: [visit({ data: { domain: "echo-check.example" } })],
        "sentinel-key": "sentinel-value",
      })
      .catch((e: unknown) => e);
    expect(JSON.stringify((error as AppException).extensions)).not.toMatch(/sentinel|echo/);
  });

  it("passes the caller's tenancy, the clock's hour bucket and only valid events to storage", async () => {
    const { ingest, calls, clock } = service();
    clock.set("2026-10-14T15:42:00.000Z");
    const event = visit({ occurredAt: "2026-10-14T15:00:00.000Z" });
    await ingest.ingestBatch(USER, INTEGRATION, { events: [event, { nope: 1 }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userId).toBe(USER);
    expect(calls[0]?.integrationId).toBe(INTEGRATION);
    expect(calls[0]?.batch.bucket.toISOString()).toBe("2026-10-14T15:00:00.000Z");
    expect(calls[0]?.batch.events.map((e) => e.clientEventId)).toEqual([event.id]);
    expect(calls[0]?.batch.events[0]?.receivedAt.toISOString()).toBe("2026-10-14T15:42:00.000Z");
  });

  it("returns results whose counters are exactly what storage records", async () => {
    const { ingest, calls } = service();
    const id = randomUUID();
    const first = await ingest.ingestBatch(USER, INTEGRATION, {
      events: [visit({ id }), visit({ id }), visit({ type: "x.y" })],
    });
    const second = await ingest.ingestBatch(USER, INTEGRATION, { events: [visit({ id })] });
    expect(first.results.map((r) => r.status)).toEqual(["accepted", "duplicate", "rejected"]);
    expect(second.results.map((r) => r.status)).toEqual(["duplicate"]);
    expect(calls.map((call) => call.counts)).toEqual([
      countResults(first.results),
      countResults(second.results),
    ]);
  });

  it("still records the counters when every item was rejected", async () => {
    const { ingest, calls } = service();
    await ingest.ingestBatch(USER, INTEGRATION, { events: [{ nope: 1 }] });
    expect(calls[0]?.batch.events).toEqual([]);
    expect(calls[0]?.counts).toMatchObject({ rejected: 1, accepted: 0 });
  });
});
