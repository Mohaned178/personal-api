/**
 * M6-06 export round trip against the real application (Testcontainers; CI runs these, Docker may
 * be off locally), with the two-user fixture and a fixed clock.
 *
 * `exports.int.spec.ts` seeds rows with SQL. This one starts at the front door: every registered
 * event type goes through `POST /v1/ingest/events` (one with a process rule's tag and retention,
 * one with a clamped future timestamp), one stored event is deleted, then the export runs and
 * every line of the file is checked against `packages/contracts`:
 *  - the stored-event schema (strict), the registry's schema for `type@typeVersion`, and the
 *    ingest envelope again (an exported line can be sent back to `parseEvent`);
 *  - the file holds exactly the caller's surviving events, newest first, equal to what the
 *    database holds, and nothing of the other user or of the deleted event;
 *  - the manifest matches the bytes on disk.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  EVENT_TYPES,
  eventTypeKey,
  exportManifestSchema,
  exportResponseSchema,
  getEventDataSchema,
  parseEvent,
  type RuleDefinition,
  type StoredEvent,
  storedEventSchema,
} from "@personal-api/contracts";
import type { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  eventRows,
  expectResults,
  FIXED_NOW,
  focusSegment,
  type IngestHarness,
  isoAt,
  type Json,
  pageVisit,
  postEvents,
  startIngestHarness,
  statuses,
} from "../../../test/ingest-helpers";
import { PG_BOSS } from "../../platform/jobs/jobs.tokens";
import { RulesService } from "../rules/rules.service";
import { EXPORT_CLEANUP_QUEUE, EXPORT_RUN_QUEUE } from "./exports.jobs";
import { ExportStorage } from "./exports.storage";
import { ExportsRunService } from "./exports-run.service";

let h: IngestHarness;
let boss: PgBoss;
let runner: ExportsRunService;
let storage: ExportStorage;

beforeAll(async () => {
  h = await startIngestHarness();
  boss = h.app.get<PgBoss>(PG_BOSS);
  runner = h.app.get(ExportsRunService);
  storage = h.app.get(ExportStorage);
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.reset();
  await boss.deleteAllJobs(EXPORT_RUN_QUEUE);
  await boss.deleteAllJobs(EXPORT_CLEANUP_QUEUE);
});

const minutesAgo = (minutes: number) => isoAt(FIXED_NOW, -minutes * 60_000);

/** One valid event of a registered type besides `browser.page_visited` and `browser.focus_segment`. */
function simple(id: string, type: string, occurredAt: string, data: Json): Json {
  return { id, type, typeVersion: 1, occurredAt, data };
}

describe("an export of events that arrived through ingest", () => {
  it("holds every line valid against the contracts, equal to the stored rows, newest first", async () => {
    const { a, b } = h;
    await h.app.get(RulesService).create(a.userId, {
      name: "tag and keep",
      enabled: true,
      priority: 10,
      stage: "process",
      when: { all: [{ field: "data.domain", op: "eq", value: "tagged.example" }] },
      // biome-ignore lint/suspicious/noThenProperty: `then` is the rule format\'s own key.
      then: [
        { action: "tag", tag: "work" },
        { action: "set_retention", days: 30 },
      ],
    } as RuleDefinition);

    const ids = {
      tagged: crypto.randomUUID(),
      clamped: crypto.randomUUID(),
      deleted: crypto.randomUUID(),
    };
    const batch = [
      pageVisit({ id: ids.tagged, occurredAt: minutesAgo(1), data: { domain: "tagged.example" } }),
      focusSegment({ occurredAt: minutesAgo(2) }),
      simple(crypto.randomUUID(), "browser.tab_opened", minutesAgo(3), {
        tabRef: "tab-ref-12345678",
        domain: "example.com",
      }),
      simple(crypto.randomUUID(), "browser.tab_closed", minutesAgo(4), {
        tabRef: "tab-ref-12345678",
      }),
      simple(crypto.randomUUID(), "browser.session_started", minutesAgo(5), { reason: "resume" }),
      simple(crypto.randomUUID(), "browser.session_ended", minutesAgo(6), {
        reason: "recovered",
      }),
      // Ten minutes ahead: ingest clamps it to receivedAt (= FIXED_NOW) and flags it.
      pageVisit({ id: ids.clamped, occurredAt: isoAt(FIXED_NOW, 10 * 60_000) }),
      pageVisit({ id: ids.deleted, occurredAt: minutesAgo(7) }),
    ];
    expect(statuses(expectResults(await postEvents(h.app, a.ingestKey, batch)))).toEqual(
      batch.map(() => "accepted"),
    );
    expectResults(await postEvents(h.app, b.ingestKey, [pageVisit()]));
    const bIds = (await eventRows(h.testDb.pool, b.userId)).map((r) => r.id);
    expect(bIds).toHaveLength(1);

    const deletedRow = (await eventRows(h.testDb.pool, a.userId)).find(
      (r) => r.client_event_id === ids.deleted,
    );
    const removed = await request(h.app.getHttpServer())
      .delete("/v1/events")
      .set("Cookie", a.cookie)
      .send({ ids: [deletedRow?.id] });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toEqual({ deleted: 1 });

    const created = await request(h.app.getHttpServer())
      .post("/v1/exports")
      .set("Cookie", a.cookie)
      .send({});
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    const exportId = exportResponseSchema.parse(created.body).export.id;
    expect(await runner.run(a.userId, exportId)).toBe(batch.length - 1);

    const raw = readFileSync(storage.file(exportId, "events.ndjson.gz"));
    const text = gunzipSync(raw).toString("utf8");
    expect(text.endsWith("\n")).toBe(true);
    const fileLines = text.trimEnd().split("\n");
    const exported: StoredEvent[] = fileLines.map((line) =>
      storedEventSchema.parse(JSON.parse(line)),
    );

    // Each line against the registry, and as an envelope again: it can be sent back to ingest.
    for (const event of exported) {
      const dataSchema = getEventDataSchema(eventTypeKey(event.type, event.typeVersion));
      expect(dataSchema, `${event.type}@${event.typeVersion} is registered`).toBeDefined();
      expect(dataSchema?.safeParse(event.data).success, `${event.type} data`).toBe(true);
      const envelope = {
        id: event.id,
        type: event.type,
        typeVersion: event.typeVersion,
        occurredAt: event.occurredAt,
        data: event.data,
      };
      expect(parseEvent(envelope).ok, `${event.type} as an envelope`).toBe(true);
    }
    // A new registered type must be added to the batch above.
    expect(new Set(exported.map((e) => e.type))).toEqual(EVENT_TYPES);

    // Equal to the database, in order, for this user only.
    const stored = await eventRows(h.testDb.pool, a.userId);
    const newestFirst = [...stored].sort(
      (x, y) => y.occurred_at.getTime() - x.occurred_at.getTime() || (x.id < y.id ? 1 : -1),
    );
    expect(exported.map((e) => e.id)).toEqual(newestFirst.map((r) => r.id));
    expect(exported).toHaveLength(batch.length - 1);
    for (const row of stored) {
      expect(exported.find((e) => e.id === row.id)).toEqual({
        id: row.id,
        integrationId: row.integration_id,
        type: row.type,
        typeVersion: row.type_version,
        occurredAt: row.occurred_at.toISOString(),
        receivedAt: row.received_at.toISOString(),
        origin: row.origin,
        data: row.data,
        tags: row.tags,
        trace: row.trace,
      });
    }
    for (const id of bIds) expect(text).not.toContain(id);
    expect(text).not.toContain(a.userId);
    expect(text).not.toContain(b.userId);
    expect(text).not.toContain(deletedRow?.id ?? "missing");

    // What ingest decided is in the file: the rule's tag and trace, the clamped time.
    const tagged = exported.find((e) => (e.data as Json).domain === "tagged.example");
    expect(tagged?.tags).toEqual(["work"]);
    expect(tagged?.trace?.matched.flatMap((m) => m.actions)).toEqual(
      expect.arrayContaining(["tag", "set_retention"]),
    );
    const clamped = stored.find((r) => r.client_event_id === ids.clamped);
    expect(clamped?.client_occurred_at).not.toBeNull();
    expect(exported[0]?.id).toBe(clamped?.id);
    expect(exported[0]?.occurredAt).toBe(FIXED_NOW);
    expect(text).not.toContain("clientOccurredAt");

    // The manifest describes these bytes.
    const manifest = exportManifestSchema.parse(
      JSON.parse(readFileSync(storage.file(exportId, "manifest.json"), "utf8")),
    );
    expect(manifest).toMatchObject({ exportId, eventCount: exported.length, filter: {} });
    expect(manifest.file.bytes).toBe(raw.length);
    expect(manifest.file.sha256).toBe(createHash("sha256").update(raw).digest("hex"));
  });
});
