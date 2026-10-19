/**
 * M6-02 retention jobs against the real application (Testcontainers; CI runs these, Docker may be
 * off locally), with the two-user fixture and a fixed clock.
 *
 * The "done when" criteria below are the ones derived from the task line (the plan has none):
 *  - the hourly purge deletes exactly the expired rows of every user, in bounded batches, and never
 *    a row without an `expires_at`; running it twice or in parallel is safe;
 *  - the purge and an ingest running at the same time lose and delete nothing wrongly;
 *  - a policy change (PUT / DELETE) enqueues one delayed recompute job per user; it re-derives
 *    `expires_at` as `received_at + resolved days` for that user only, leaves `set_retention`
 *    events alone (rule > type > source > default), backfills NULLs and is idempotent;
 *  - the real worker process registers the queues and the hourly schedule, and runs the purge.
 */
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authTestConfig } from "../../../test/auth.helpers";
import {
  DAY_MS,
  eventRows,
  FIXED_NOW,
  type IngestHarness,
  pageVisit,
  postEvents,
  startIngestHarness,
} from "../../../test/ingest-helpers";
import type { FixtureUser } from "../../../test/two-user-fixture";
import { APP_CONFIG } from "../../config/config.module";
import { PG_BOSS } from "../../platform/jobs/jobs.tokens";
import { WorkerModule } from "../../worker.module";
import {
  RECOMPUTE_DELAY_SECONDS,
  RETENTION_PURGE_CRON,
  RETENTION_PURGE_QUEUE,
  RETENTION_RECOMPUTE_QUEUE,
} from "./retention.jobs";
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
  await boss.deleteAllJobs(RETENTION_PURGE_QUEUE);
  await boss.deleteAllJobs(RETENTION_RECOMPUTE_QUEUE);
});

const TYPE = "browser.page_visited";
const NOW = new Date(FIXED_NOW);
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const http = () => request(h.app.getHttpServer());
const put = (u: FixtureUser, path: string, days: number) =>
  http().put(`/v1/retention/${path}`).set("Cookie", u.cookie).send({ days });
const del = (u: FixtureUser, path: string) =>
  http().delete(`/v1/retention/${path}`).set("Cookie", u.cookie);

interface Seed {
  user: FixtureUser;
  expiresAt: Date | null;
  receivedAt?: Date;
  type?: string;
  trace?: unknown;
  integrationId?: string;
}

/** Inserts one event directly, so `expires_at`, `received_at` and `trace` are exactly as the test says. */
async function seed(pool: Pool, s: Seed): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into events (user_id, integration_id, client_event_id, type, type_version,
       occurred_at, received_at, data, trace, expires_at)
     values ($1, $2, $3, $4, 1, $5, $6, '{}'::jsonb, $7, $8) returning id`,
    [
      s.user.userId,
      s.integrationId ?? s.user.integrationId,
      randomUUID(),
      s.type ?? TYPE,
      s.receivedAt ?? NOW,
      s.receivedAt ?? NOW,
      s.trace === undefined ? null : JSON.stringify(s.trace),
      s.expiresAt,
    ],
  );
  return (rows[0] as { id: string }).id;
}

const ruleTrace = (actions: string[]) => ({
  ruleSetVersion: 1,
  matched: [{ ruleId: randomUUID(), actions }],
  decidedBy: "default_policy",
});

const expiry = async (id: string): Promise<Date | null> => {
  const { rows } = await h.testDb.pool.query<{ expires_at: Date | null }>(
    "select expires_at from events where id = $1",
    [id],
  );
  return rows[0]?.expires_at ?? null;
};

const count = async (userId?: string): Promise<number> =>
  (await eventRows(h.testDb.pool, userId)).length;

describe("the purge", () => {
  it("deletes expired events of every user, keeps unexpired ones and ones without expires_at", async () => {
    const { pool } = h.testDb;
    const expiredA = await seed(pool, { user: h.a, expiresAt: at(-DAY_MS) });
    const expiredB = await seed(pool, { user: h.b, expiresAt: at(-1) });
    const keptA = await seed(pool, { user: h.a, expiresAt: at(DAY_MS) });
    const keptB = await seed(pool, { user: h.b, expiresAt: at(1) });
    const unset = await seed(pool, { user: h.a, expiresAt: null });

    expect(await purge.run()).toBe(2);

    const left = (await eventRows(pool)).map((r) => r.id).sort();
    expect(left).toEqual([keptA, keptB, unset].sort());
    expect(left).not.toContain(expiredA);
    expect(left).not.toContain(expiredB);
  });

  it("treats exactly-now as expired and one millisecond later as alive", async () => {
    const { pool } = h.testDb;
    await seed(pool, { user: h.a, expiresAt: NOW });
    const alive = await seed(pool, { user: h.a, expiresAt: at(1) });
    expect(await purge.run()).toBe(1);
    expect((await eventRows(pool)).map((r) => r.id)).toEqual([alive]);
  });

  it("reads the injected clock: nothing goes before its time, everything after", async () => {
    await setDefaultAllow();
    await postEvents(h.app, h.a.ingestKey, [pageVisit()]);
    const [stored] = await eventRows(h.testDb.pool, h.a.userId);
    expect(stored?.expires_at?.getTime()).toBe(NOW.getTime() + 90 * DAY_MS);

    h.clock.set(at(90 * DAY_MS - 1));
    expect(await purge.run()).toBe(0);
    h.clock.set(at(90 * DAY_MS));
    expect(await purge.run()).toBe(1);
    expect(await count()).toBe(0);
  });

  it("works in bounded batches: one run deletes at most batchSize * maxBatches, the next finishes", async () => {
    for (let i = 0; i < 7; i++) await seed(h.testDb.pool, { user: h.a, expiresAt: at(-DAY_MS) });
    expect(await purge.run({ batchSize: 2, maxBatches: 2 })).toBe(4);
    expect(await count()).toBe(3);
    expect(await purge.run({ batchSize: 2, maxBatches: 2 })).toBe(3);
    expect(await count()).toBe(0);
    expect(await purge.run()).toBe(0);
  });

  it("is safe to run twice at the same time: every row goes once, nothing throws", async () => {
    for (let i = 0; i < 40; i++) await seed(h.testDb.pool, { user: h.a, expiresAt: at(-DAY_MS) });
    const kept = await seed(h.testDb.pool, { user: h.b, expiresAt: at(DAY_MS) });
    const runs = await Promise.all([
      purge.run({ batchSize: 3 }),
      purge.run({ batchSize: 3 }),
      purge.run({ batchSize: 3 }),
    ]);
    expect(runs.reduce((sum, n) => sum + n, 0)).toBe(40);
    expect((await eventRows(h.testDb.pool)).map((r) => r.id)).toEqual([kept]);
  });

  it("running while ingest stores events deletes only expired rows and loses no new event", async () => {
    await setDefaultAllow();
    for (let i = 0; i < 30; i++) await seed(h.testDb.pool, { user: h.b, expiresAt: at(-DAY_MS) });
    const batches = Array.from({ length: 5 }, () => [pageVisit(), pageVisit(), pageVisit()]);
    await Promise.all([
      purge.run({ batchSize: 4 }),
      ...batches.map((events) => postEvents(h.app, h.a.ingestKey, events)),
      purge.run({ batchSize: 4 }),
    ]);
    expect(await count(h.a.userId)).toBe(15);
    expect(await count(h.b.userId)).toBe(0);
  });

  it("keeps ingestion counters (it only ever removes events)", async () => {
    await setDefaultAllow();
    await postEvents(h.app, h.a.ingestKey, [pageVisit()]);
    h.clock.set(at(91 * DAY_MS));
    await purge.run();
    const { rows } = await h.testDb.pool.query("select accepted from ingestion_log");
    expect(rows).toEqual([{ accepted: 1 }]);
  });
});

describe("a policy change", () => {
  const queued = (userId: string) => boss.findJobs(RETENTION_RECOMPUTE_QUEUE, { key: userId });

  it("enqueues one recompute job for the user, delayed, carrying only the user id", async () => {
    expect((await put(h.a, `type/${TYPE}`, 30)).status).toBe(200);
    const jobs = await queued(h.a.userId);
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(job?.data).toEqual({ userId: h.a.userId });
    const delayMs = (job?.startAfter.getTime() ?? 0) - (job?.createdOn.getTime() ?? 0);
    expect(delayMs).toBeGreaterThanOrEqual(RECOMPUTE_DELAY_SECONDS * 1000 - 2000);
    expect(await queued(h.b.userId)).toHaveLength(0);
  });

  it("folds a burst of changes into one queued job, and DELETE counts as a change", async () => {
    await put(h.a, `type/${TYPE}`, 30);
    await put(h.a, `type/${TYPE}`, 14);
    await put(h.a, `source/${h.a.integrationId}`, 7);
    await del(h.a, `type/${TYPE}`);
    expect(await queued(h.a.userId)).toHaveLength(1);
  });

  it("enqueues nothing when the change is refused", async () => {
    expect((await put(h.a, `source/${h.b.integrationId}`, 5)).status).toBe(404);
    expect((await put(h.a, `type/${TYPE}`, 0)).status).toBe(400);
    expect((await del(h.a, `type/${TYPE}`)).status).toBe(404);
    expect(await queued(h.a.userId)).toHaveLength(0);
  });

  it("gives each user their own job", async () => {
    await put(h.a, `type/${TYPE}`, 30);
    await put(h.b, `type/${TYPE}`, 30);
    expect(await queued(h.a.userId)).toHaveLength(1);
    expect(await queued(h.b.userId)).toHaveLength(1);
  });
});

describe("the recompute", () => {
  const setPolicy = async (
    user: FixtureUser,
    scope: "type" | "source",
    target: string,
    days: number,
  ) => {
    const res = await put(user, `${scope}/${target}`, days);
    expect(res.status).toBe(200);
  };

  it("rewrites expires_at to received_at + the resolved days (type > source > default)", async () => {
    const { pool } = h.testDb;
    const received = at(-10 * DAY_MS);
    const visit = await seed(pool, { user: h.a, receivedAt: received, expiresAt: at(80 * DAY_MS) });
    const other = await seed(pool, {
      user: h.a,
      receivedAt: received,
      type: "browser.focus_segment",
      expiresAt: at(80 * DAY_MS),
    });
    await setPolicy(h.a, "source", h.a.integrationId, 30);
    await setPolicy(h.a, "type", TYPE, 7);

    expect(await recompute.run(h.a.userId)).toBe(2);
    expect(await expiry(visit)).toEqual(new Date(received.getTime() + 7 * DAY_MS));
    expect(await expiry(other)).toEqual(new Date(received.getTime() + 30 * DAY_MS));
  });

  it("goes back to 90 days when the policies are deleted", async () => {
    const received = at(-10 * DAY_MS);
    const id = await seed(h.testDb.pool, {
      user: h.a,
      receivedAt: received,
      expiresAt: at(DAY_MS),
    });
    await setPolicy(h.a, "type", TYPE, 7);
    await recompute.run(h.a.userId);
    expect(await expiry(id)).toEqual(new Date(received.getTime() + 7 * DAY_MS));

    expect((await del(h.a, `type/${TYPE}`)).status).toBe(204);
    await recompute.run(h.a.userId);
    expect(await expiry(id)).toEqual(new Date(received.getTime() + 90 * DAY_MS));
  });

  it("leaves events a set_retention rule governs alone, and still fixes the others", async () => {
    const { pool } = h.testDb;
    const ruleExpiry = at(3 * DAY_MS);
    const governed = await seed(pool, {
      user: h.a,
      expiresAt: ruleExpiry,
      trace: ruleTrace(["tag", "set_retention"]),
    });
    const taggedOnly = await seed(pool, {
      user: h.a,
      expiresAt: at(90 * DAY_MS),
      trace: ruleTrace(["tag"]),
    });
    await setPolicy(h.a, "type", TYPE, 5);

    expect(await recompute.run(h.a.userId)).toBe(1);
    expect(await expiry(governed)).toEqual(ruleExpiry);
    expect(await expiry(taggedOnly)).toEqual(new Date(NOW.getTime() + 5 * DAY_MS));
  });

  it("backfills events that have no expires_at yet (stored before M6-01), trace or not", async () => {
    const withTrace = await seed(h.testDb.pool, {
      user: h.a,
      expiresAt: null,
      trace: ruleTrace(["tag"]),
    });
    const bare = await seed(h.testDb.pool, { user: h.a, expiresAt: null });
    await recompute.run(h.a.userId);
    expect(await expiry(withTrace)).toEqual(at(90 * DAY_MS));
    expect(await expiry(bare)).toEqual(at(90 * DAY_MS));
  });

  it("never touches another user's events (cross-tenant), even with a policy of its own", async () => {
    const { pool } = h.testDb;
    const a = await seed(pool, { user: h.a, expiresAt: at(90 * DAY_MS) });
    const b = await seed(pool, { user: h.b, expiresAt: at(90 * DAY_MS) });
    await setPolicy(h.a, "type", TYPE, 1);

    expect(await recompute.run(h.a.userId)).toBe(1);
    expect(await expiry(a)).toEqual(at(DAY_MS));
    expect(await expiry(b)).toEqual(at(90 * DAY_MS));

    // And B's own run applies B's policies, not A's.
    expect(await recompute.run(h.b.userId)).toBe(0);
    expect(await expiry(b)).toEqual(at(90 * DAY_MS));
  });

  it("is idempotent: a second run changes nothing", async () => {
    for (let i = 0; i < 5; i++)
      await seed(h.testDb.pool, { user: h.a, expiresAt: at(90 * DAY_MS) });
    await setPolicy(h.a, "type", TYPE, 9);
    expect(await recompute.run(h.a.userId)).toBe(5);
    const before = await eventRows(h.testDb.pool, h.a.userId);
    expect(await recompute.run(h.a.userId)).toBe(0);
    expect(await eventRows(h.testDb.pool, h.a.userId)).toEqual(before);
  });

  it("walks pages: every event is covered when there are more than one batch", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      ids.push(
        await seed(h.testDb.pool, {
          user: h.a,
          receivedAt: at(-i * 1000),
          expiresAt: at(90 * DAY_MS),
        }),
      );
    }
    await setPolicy(h.a, "type", TYPE, 2);
    expect(await recompute.run(h.a.userId, { batchSize: 3 })).toBe(11);
    for (const id of ids) {
      const row = (await eventRows(h.testDb.pool)).find((r) => r.id === id);
      expect(row?.expires_at?.getTime()).toBe((row?.received_at.getTime() ?? 0) + 2 * DAY_MS);
    }
  });

  it("converges after an ingest that still used the old policy (stored after the change)", async () => {
    await setDefaultAllow();
    await setPolicy(h.a, "type", TYPE, 10);
    // An in-flight batch read the policies before the change and commits with 90 days.
    const stale = await seed(h.testDb.pool, { user: h.a, expiresAt: at(90 * DAY_MS) });
    await recompute.run(h.a.userId);
    expect(await expiry(stale)).toEqual(at(10 * DAY_MS));
  });

  it("running with the purge at the same time deadlocks nothing and ends consistent", async () => {
    const { pool } = h.testDb;
    for (let i = 0; i < 40; i++) {
      await seed(pool, { user: h.a, receivedAt: at(-i * 1000), expiresAt: at(90 * DAY_MS) });
      await seed(pool, { user: h.a, expiresAt: at(-DAY_MS) });
    }
    await setPolicy(h.a, "type", TYPE, 20);
    await Promise.all([
      recompute.run(h.a.userId, { batchSize: 5 }),
      purge.run({ batchSize: 5 }),
      purge.run({ batchSize: 5 }),
    ]);
    const rows = await eventRows(pool, h.a.userId);
    expect(rows.length).toBeGreaterThanOrEqual(40);
    expect(rows.length).toBeLessThanOrEqual(80);
    // The recompute may run before the purge (the old, expired rows get 20 days from NOW and stay)
    // or after it; either way a second pass leaves every row on its policy.
    await recompute.run(h.a.userId);
    for (const row of await eventRows(pool, h.a.userId)) {
      expect(row.expires_at?.getTime()).toBe(row.received_at.getTime() + 20 * DAY_MS);
    }
  });
});

describe("the worker process", () => {
  it("registers both queues and the hourly purge schedule, and runs a purge job", async () => {
    const worker = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(authTestConfig(h.testDb, { allowSignup: false }))
      .compile();
    await worker.init();
    try {
      for (const queue of [RETENTION_PURGE_QUEUE, RETENTION_RECOMPUTE_QUEUE]) {
        expect(await boss.getQueue(queue), queue).not.toBeNull();
      }
      const schedules = await boss.getSchedules(RETENTION_PURGE_QUEUE);
      expect(schedules.map((s) => s.cron)).toEqual([RETENTION_PURGE_CRON]);
      expect(await boss.getSchedules(RETENTION_RECOMPUTE_QUEUE)).toEqual([]);

      // The worker uses the system clock, so use real time here.
      const real = Date.now();
      const { pool } = h.testDb;
      await seed(pool, { user: h.a, expiresAt: new Date(real - DAY_MS) });
      const kept = await seed(pool, { user: h.a, expiresAt: new Date(real + DAY_MS) });
      const jobId = await boss.send(RETENTION_PURGE_QUEUE, {});
      await expect
        .poll(
          async () => (await boss.findJobs(RETENTION_PURGE_QUEUE, { id: jobId ?? "" }))[0]?.state,
          {
            timeout: 30_000,
            interval: 250,
          },
        )
        .toBe("completed");
      expect((await eventRows(pool)).map((r) => r.id)).toEqual([kept]);
    } finally {
      await worker.close();
    }
  }, 60_000);
});

async function setDefaultAllow(): Promise<void> {
  await h.testDb.pool.query("update integrations set default_policy = 'allow'");
}
