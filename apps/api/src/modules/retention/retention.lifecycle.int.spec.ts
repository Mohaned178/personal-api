/**
 * M6-06 retention over time, against the real application (Testcontainers; CI runs these, Docker
 * may be off locally), with the two-user fixture and a fake clock.
 *
 * The pieces are pinned one by one in `retention.int.spec.ts` and `retention.jobs.int.spec.ts`.
 * This is the chain a user lives through, with nothing seeded by SQL: a policy is set over HTTP,
 * events arrive through ingest, the policy is shortened, the recompute job re-derives the expiry,
 * and the clock then walks across each boundary (one millisecond before keeps the event, the
 * boundary itself purges it). Afterwards an export omits what was purged, the ingestion counters
 * are intact and the other user's events never moved.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  exportResponseSchema,
  type RuleDefinition,
  storedEventSchema,
} from "@personal-api/contracts";
import type { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DAY_MS,
  eventRows,
  expectResults,
  FIXED_NOW,
  type IngestHarness,
  pageVisit,
  postEvents,
  startIngestHarness,
} from "../../../test/ingest-helpers";
import { PG_BOSS } from "../../platform/jobs/jobs.tokens";
import { EXPORT_CLEANUP_QUEUE, EXPORT_RUN_QUEUE } from "../exports/exports.jobs";
import { ExportStorage } from "../exports/exports.storage";
import { ExportsRunService } from "../exports/exports-run.service";
import { RulesService } from "../rules/rules.service";
import { RETENTION_PURGE_QUEUE, RETENTION_RECOMPUTE_QUEUE } from "./retention.jobs";
import { RetentionPurgeService } from "./retention-purge.service";
import { RetentionRecomputeService } from "./retention-recompute.service";

let h: IngestHarness;
let boss: PgBoss;
let purge: RetentionPurgeService;
let recompute: RetentionRecomputeService;

beforeAll(async () => {
  h = await startIngestHarness();
  boss = h.app.get<PgBoss>(PG_BOSS);
  purge = h.app.get(RetentionPurgeService);
  recompute = h.app.get(RetentionRecomputeService);
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.reset();
  for (const queue of [
    RETENTION_PURGE_QUEUE,
    RETENTION_RECOMPUTE_QUEUE,
    EXPORT_RUN_QUEUE,
    EXPORT_CLEANUP_QUEUE,
  ]) {
    await boss.deleteAllJobs(queue);
  }
});

const NOW = Date.parse(FIXED_NOW);
const atDay = (days: number, offsetMs = 0) => new Date(NOW + days * DAY_MS + offsetMs);

describe("a user's retention, from policy to purge", () => {
  it("follows the policy through ingest, a shortened policy, the recompute job and the clock", async () => {
    const { a, b } = h;
    const http = () => request(h.app.getHttpServer());
    const putPolicy = (path: string, days: number) =>
      http().put(`/v1/retention/${path}`).set("Cookie", a.cookie).send({ days });
    const expiresOf = async (userId: string) =>
      Object.fromEntries(
        (await eventRows(h.testDb.pool, userId)).map((r) => [
          (r.data as { domain: string }).domain,
          r.expires_at?.getTime(),
        ]),
      );

    // A: visits of one domain follow the type policy; a process rule fixes another at 60 days;
    // the third has no policy at all (90 days). B has no policy.
    expect((await putPolicy("type/browser.page_visited", 30)).status).toBe(200);
    await h.app.get(RulesService).create(a.userId, {
      name: "keep rule.example for 60 days",
      enabled: true,
      priority: 10,
      stage: "process",
      when: { all: [{ field: "data.domain", op: "eq", value: "rule.example" }] },
      // biome-ignore lint/suspicious/noThenProperty: `then` is the rule format\'s own key.
      then: [{ action: "set_retention", days: 60 }],
    } as RuleDefinition);
    expectResults(
      await postEvents(h.app, a.ingestKey, [
        pageVisit({ data: { domain: "policy.example" } }),
        pageVisit({ data: { domain: "rule.example" } }),
      ]),
    );
    expectResults(
      await postEvents(h.app, a.ingestKey, [
        {
          id: crypto.randomUUID(),
          type: "browser.tab_opened",
          typeVersion: 1,
          occurredAt: new Date(NOW - 60_000).toISOString(),
          data: { tabRef: "tab-ref-12345678", domain: "default.example" },
        },
      ]),
    );
    expectResults(
      await postEvents(h.app, b.ingestKey, [pageVisit({ data: { domain: "b.example" } })]),
    );
    expect(await expiresOf(a.userId)).toEqual({
      "policy.example": atDay(30).getTime(),
      "rule.example": atDay(60).getTime(),
      "default.example": atDay(90).getTime(),
    });
    expect(await expiresOf(b.userId)).toEqual({ "b.example": atDay(90).getTime() });

    // Shorten the policy: the recompute changes the one event the policy governs, and no other.
    expect((await putPolicy("type/browser.page_visited", 7)).status).toBe(200);
    expect(await recompute.run(a.userId)).toBe(1);
    expect(await expiresOf(a.userId)).toEqual({
      "policy.example": atDay(7).getTime(),
      "rule.example": atDay(60).getTime(),
      "default.example": atDay(90).getTime(),
    });

    // Seven days: one millisecond early keeps everything, the boundary purges the policy's event.
    h.clock.set(atDay(7, -1));
    expect(await purge.run()).toBe(0);
    h.clock.set(atDay(7));
    expect(await purge.run()).toBe(1);
    expect(Object.keys(await expiresOf(a.userId)).sort()).toEqual([
      "default.example",
      "rule.example",
    ]);

    // An export made now omits it, and ingestion keeps counting what was accepted, not what is stored.
    const created = await http().post("/v1/exports").set("Cookie", a.cookie).send({});
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    const exportId = exportResponseSchema.parse(created.body).export.id;
    expect(await h.app.get(ExportsRunService).run(a.userId, exportId)).toBe(2);
    const file = readFileSync(h.app.get(ExportStorage).file(exportId, "events.ndjson.gz"));
    const exportedDomains = gunzipSync(file)
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => (storedEventSchema.parse(JSON.parse(line)).data as { domain: string }).domain);
    expect(exportedDomains.sort()).toEqual(["default.example", "rule.example"]);
    const { rows: counters } = await h.testDb.pool.query<{ accepted: number }>(
      "select coalesce(sum(accepted), 0)::int as accepted from ingestion_log where user_id = $1",
      [a.userId],
    );
    expect(counters[0]?.accepted).toBe(3);

    // Sixty days, then ninety: each boundary takes exactly what expires there.
    h.clock.set(atDay(60, -1));
    expect(await purge.run()).toBe(0);
    h.clock.set(atDay(60));
    expect(await purge.run()).toBe(1);
    expect(Object.keys(await expiresOf(a.userId))).toEqual(["default.example"]);
    // B's event kept its own 90 days through A's recompute and both purges.
    expect(await expiresOf(b.userId)).toEqual({ "b.example": atDay(90).getTime() });
    h.clock.set(atDay(90, -1));
    expect(await purge.run()).toBe(0);
    h.clock.set(atDay(90));
    expect(await purge.run()).toBe(2);

    expect(await eventRows(h.testDb.pool)).toEqual([]);
  });
});
