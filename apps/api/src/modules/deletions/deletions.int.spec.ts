/**
 * M6-03 bulk delete against the real application (Testcontainers; CI runs these, Docker may be
 * off locally), with the two-user fixture and a fixed clock.
 *
 * The "done when" criteria below are the ones derived from the task line (the plan has none):
 *  - `DELETE /v1/events` with a filter answers 202 with a deletion; the job deletes exactly the
 *    caller's matching events, in bounded batches, with progress (`total`, `deleted`, `status`);
 *  - running a job twice, or retrying a failed one, is safe and ends in the same state;
 *  - "disconnect and delete this integration's data" revokes the integration at once (its key
 *    gets 401), then deletes every event of that integration and no other;
 *  - another user's deletion id, integration id or `source` filter reach nothing of theirs.
 */
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import {
  deleteIntegrationDataResponseSchema,
  deletionResponseSchema,
} from "@personal-api/contracts";
import type { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authTestConfig } from "../../../test/auth.helpers";
import {
  eventRows,
  FIXED_NOW,
  type IngestHarness,
  PROBLEM_JSON,
  pageVisit,
  postEvents,
  startIngestHarness,
} from "../../../test/ingest-helpers";
import type { FixtureUser } from "../../../test/two-user-fixture";
import { APP_CONFIG } from "../../config/config.module";
import { PG_BOSS } from "../../platform/jobs/jobs.tokens";
import { WorkerModule } from "../../worker.module";
import { BULK_DELETE_QUEUE, INTEGRATION_DELETE_DELAY_SECONDS } from "./deletions.jobs";
import { DeletionsRunService } from "./deletions-run.service";

let h: IngestHarness;
let boss: PgBoss;
let runner: DeletionsRunService;

beforeAll(async () => {
  h = await startIngestHarness();
  boss = h.app.get<PgBoss>(PG_BOSS);
  runner = h.app.get(DeletionsRunService);
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.reset();
  await boss.deleteAllJobs(BULK_DELETE_QUEUE);
});

const T0 = Date.parse(FIXED_NOW);
const at = (minutesAgo: number) => new Date(T0 - minutesAgo * 60_000).toISOString();

const http = () => request(h.app.getHttpServer());
const del = (u: FixtureUser, body: unknown) =>
  http()
    .delete("/v1/events")
    .set("Cookie", u.cookie)
    .send(body as object);
const getDeletion = (u: FixtureUser, id: string) =>
  http().get(`/v1/events/deletions/${id}`).set("Cookie", u.cookie);

async function seed(
  user: FixtureUser,
  options: { minutesAgo?: number; type?: string; domain?: string; integrationId?: string } = {},
): Promise<string> {
  const { rows } = await h.testDb.pool.query<{ id: string }>(
    `insert into events (user_id, integration_id, client_event_id, type, type_version, occurred_at, data)
     values ($1, $2, $3, $4, 1, $5, $6::jsonb) returning id`,
    [
      user.userId,
      options.integrationId ?? user.integrationId,
      randomUUID(),
      options.type ?? "browser.page_visited",
      at(options.minutesAgo ?? 0),
      JSON.stringify({ domain: options.domain ?? "example.com", path: "/" }),
    ],
  );
  return (rows[0] as { id: string }).id;
}

const remaining = async (user: FixtureUser) =>
  (await eventRows(h.testDb.pool, user.userId)).map((r) => r.id).sort();

/** The deletion a filter request started, as the API shows it, and its id. */
async function startFilter(user: FixtureUser, filter: object) {
  const res = await del(user, { filter });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return deletionResponseSchema.parse(res.body).deletion;
}

describe("DELETE /v1/events with a filter", () => {
  it("answers 202 with a queued deletion and enqueues one job that carries ids only", async () => {
    await seed(h.a);
    const deletion = await startFilter(h.a, { domain: "example.com" });
    expect(deletion).toMatchObject({
      kind: "events",
      status: "queued",
      total: null,
      deleted: 0,
      finishedAt: null,
    });
    const { rows } = await h.testDb.pool.query<{ data: unknown }>(
      "select data from pgboss.job where name = $1",
      [BULK_DELETE_QUEUE],
    );
    expect(rows.map((r) => r.data)).toEqual([{ userId: h.a.userId, deletionId: deletion.id }]);
    // Nothing is deleted until the job runs.
    expect(await remaining(h.a)).toHaveLength(1);
  });

  it("deletes the caller's matching events and nothing else, and reports progress", async () => {
    const { a, b } = h;
    const hit1 = await seed(a, { domain: "gone.example" });
    const hit2 = await seed(a, { domain: "gone.example", type: "browser.tab_opened" });
    const keepDomain = await seed(a, { domain: "kept.example" });
    const bHit = await seed(b, { domain: "gone.example" });
    const deletion = await startFilter(a, { domain: "gone.example" });

    expect(await runner.run(a.userId, deletion.id)).toBe(2);

    expect(await remaining(a)).toEqual([keepDomain]);
    expect(await remaining(b)).toEqual([bHit]);
    expect([hit1, hit2]).not.toContain(keepDomain);
    const done = deletionResponseSchema.parse((await getDeletion(a, deletion.id)).body).deletion;
    expect(done).toMatchObject({ status: "completed", total: 2, deleted: 2 });
    expect(done.finishedAt).not.toBeNull();
  });

  it("applies every filter field together: source, type, from and to", async () => {
    const { a } = h;
    const target = await seed(a, { minutesAgo: 30, type: "browser.tab_opened" });
    const tooNew = await seed(a, { minutesAgo: 5, type: "browser.tab_opened" });
    const tooOld = await seed(a, { minutesAgo: 90, type: "browser.tab_opened" });
    const wrongType = await seed(a, { minutesAgo: 30, type: "browser.page_visited" });
    const deletion = await startFilter(a, {
      source: a.integrationId,
      type: "browser.tab_opened",
      from: at(60),
      to: at(10),
    });
    await runner.run(a.userId, deletion.id);
    expect(await remaining(a)).toEqual([tooNew, tooOld, wrongType].sort());
    expect(await remaining(a)).not.toContain(target);
  });

  it("deletes in bounded batches and records progress after each", async () => {
    const { a } = h;
    for (let i = 0; i < 7; i++) await seed(a, { minutesAgo: i });
    const deletion = await startFilter(a, { type: "browser.page_visited" });
    expect(await runner.run(a.userId, deletion.id, { batchSize: 3 })).toBe(7);
    const row = deletionResponseSchema.parse((await getDeletion(a, deletion.id)).body).deletion;
    expect(row).toMatchObject({ status: "completed", total: 7, deleted: 7 });
  });

  it("is idempotent: a second run, and a retry of a failed deletion, end in the same state", async () => {
    const { a } = h;
    await seed(a);
    const deletion = await startFilter(a, { domain: "example.com" });
    expect(await runner.run(a.userId, deletion.id)).toBe(1);
    // A finished deletion is left alone, even if new matching events arrived since.
    const later = await seed(a);
    expect(await runner.run(a.userId, deletion.id)).toBe(0);
    expect(await remaining(a)).toEqual([later]);

    // A failed deletion (the handler threw) runs again and finishes.
    await h.testDb.pool.query(
      "update bulk_deletions set status = 'failed', deleted = 0, total = null where id = $1",
      [deletion.id],
    );
    expect(await runner.run(a.userId, deletion.id)).toBe(1);
    expect(await remaining(a)).toEqual([]);
    const row = deletionResponseSchema.parse((await getDeletion(a, deletion.id)).body).deletion;
    expect(row.status).toBe("completed");
  });

  it("marks the deletion failed and rethrows when the job cannot run", async () => {
    const { a } = h;
    const deletion = await startFilter(a, { domain: "example.com" });
    // A stored filter this API cannot read (never written by the routes).
    await h.testDb.pool.query(
      "update bulk_deletions set filter = '{\"bogus\": true}'::jsonb where id = $1",
      [deletion.id],
    );
    await expect(runner.run(a.userId, deletion.id)).rejects.toThrow();
    const row = deletionResponseSchema.parse((await getDeletion(a, deletion.id)).body).deletion;
    expect(row.status).toBe("failed");
  });

  it("refuses an empty filter, both ids and a filter, unknown keys and a user id with 400", async () => {
    const id = randomUUID();
    for (const body of [
      { filter: {} },
      {},
      { ids: [id], filter: { domain: "example.com" } },
      { filter: { domain: "example.com", userId: h.b.userId } },
      { filter: { domain: "example.com" }, userId: h.b.userId },
    ]) {
      const res = await del(h.a, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe("request.invalid");
      expect(JSON.stringify(res.body)).not.toContain(h.b.userId);
    }
    expect((await h.testDb.pool.query("select 1 from bulk_deletions")).rowCount).toBe(0);
  });

  it("still deletes by ids synchronously (200 {deleted})", async () => {
    const id = await seed(h.a);
    const res = await del(h.a, { ids: [id] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 1 });
  });
});

describe("cross-tenant", () => {
  it("a filter naming the victim's integration deletes nothing of the victim's", async () => {
    const victimEvent = await seed(h.b);
    const deletion = await startFilter(h.a, { source: h.b.integrationId });
    expect(await runner.run(h.a.userId, deletion.id)).toBe(0);
    expect(await remaining(h.b)).toEqual([victimEvent]);
  });

  it("another user's deletion id is a 404 identical to an unknown one", async () => {
    await seed(h.a);
    const deletion = await startFilter(h.a, { domain: "example.com" });
    const foreign = await getDeletion(h.b, deletion.id);
    const unknown = await getDeletion(h.b, randomUUID());
    const malformed = await getDeletion(h.b, "not-a-uuid");
    for (const res of [foreign, unknown, malformed]) {
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe("deletion.not_found");
    }
    expect(foreign.body).toEqual(unknown.body);
  });

  it("a job whose payload names the wrong user finds no deletion and deletes nothing", async () => {
    const victimEvent = await seed(h.b);
    await seed(h.a);
    const deletion = await startFilter(h.a, { domain: "example.com" });
    expect(await runner.run(h.b.userId, deletion.id)).toBe(0);
    expect(await remaining(h.b)).toEqual([victimEvent]);
    expect(await remaining(h.a)).toHaveLength(1);
  });

  it("needs a session", async () => {
    const res = await http().get(`/v1/events/deletions/${randomUUID()}`);
    expect(res.status).toBe(401);
    const del401 = await http()
      .delete("/v1/events")
      .send({ filter: { domain: "example.com" } });
    expect(del401.status).toBe(401);
  });
});

describe("DELETE /v1/integrations/:id/data", () => {
  async function createHttpIntegration(user: FixtureUser) {
    const res = await http()
      .post("/v1/integrations")
      .set("Cookie", user.cookie)
      .send({ kind: "http", name: "to delete" });
    expect(res.status).toBe(201);
    return { id: res.body.integration.id as string, key: res.body.ingestKey.key as string };
  }

  it("revokes at once, delays the job, then deletes that integration's events and no other", async () => {
    const { a, b } = h;
    const target = await createHttpIntegration(a);
    await h.testDb.pool.query("update integrations set default_policy = 'allow' where id = $1", [
      target.id,
    ]);
    await seed(a, { integrationId: target.id });
    await seed(a, { integrationId: target.id, type: "browser.tab_opened" });
    const keepSameUser = await seed(a);
    const keepOtherUser = await seed(b);

    const res = await http().delete(`/v1/integrations/${target.id}/data`).set("Cookie", a.cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const body = deleteIntegrationDataResponseSchema.parse(res.body);
    expect(body.integration).toMatchObject({ id: target.id, status: "revoked" });
    expect(body.deletion).toMatchObject({ kind: "integration", status: "queued" });

    // The key is dead on the very next request.
    expect((await postEvents(h.app, target.key, [pageVisit()])).status).toBe(401);

    // The job waits out in-flight ingest before it starts.
    const { rows } = await h.testDb.pool.query<{ wait: number }>(
      "select extract(epoch from (start_after - now()))::float as wait from pgboss.job where name = $1",
      [BULK_DELETE_QUEUE],
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as { wait: number }).wait).toBeGreaterThan(
      INTEGRATION_DELETE_DELAY_SECONDS - 30,
    );

    expect(await runner.run(a.userId, body.deletion.id)).toBe(2);
    expect(await remaining(a)).toEqual([keepSameUser]);
    expect(await remaining(b)).toHaveLength(1);
    expect(await remaining(b)).toEqual([keepOtherUser]);
    const done = deletionResponseSchema.parse((await getDeletion(a, body.deletion.id)).body);
    expect(done.deletion).toMatchObject({ status: "completed", total: 2, deleted: 2 });

    // The integration stays, revoked, and the request can be repeated.
    const again = await http().delete(`/v1/integrations/${target.id}/data`).set("Cookie", a.cookie);
    expect(again.status).toBe(202);
  });

  it("also removes that integration's source retention policy, and nobody else's policies", async () => {
    const { a, b } = h;
    const target = await createHttpIntegration(a);
    const policyFor = (scope: string, target: string, days: number) =>
      http().put(`/v1/retention/${scope}/${target}`).set("Cookie", a.cookie).send({ days });
    expect((await policyFor("source", target.id, 30)).status).toBe(200);
    expect((await policyFor("source", a.integrationId, 45)).status).toBe(200);
    expect((await policyFor("type", "browser.page_visited", 60)).status).toBe(200);
    // Another user's row with the same target text (the column has no foreign key): not A's to delete.
    await h.testDb.pool.query(
      "insert into retention_policies (user_id, scope, target, days) values ($1, 'source', $2, 20)",
      [b.userId, target.id],
    );

    const res = await http().delete(`/v1/integrations/${target.id}/data`).set("Cookie", a.cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(202);

    const { rows } = await h.testDb.pool.query<{ user_id: string; scope: string; target: string }>(
      "select user_id, scope, target from retention_policies order by user_id, scope, target",
    );
    expect(rows.map((r) => [r.user_id, r.scope, r.target]).sort()).toEqual(
      [
        [a.userId, "source", a.integrationId],
        [a.userId, "type", "browser.page_visited"],
        [b.userId, "source", target.id],
      ].sort(),
    );
  });

  it("answers 404 for another user's integration and starts nothing", async () => {
    const victimEvent = await seed(h.b);
    const res = await http()
      .delete(`/v1/integrations/${h.b.integrationId}/data`)
      .set("Cookie", h.a.cookie);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("integration.not_found");
    const unknown = await http()
      .delete(`/v1/integrations/${randomUUID()}/data`)
      .set("Cookie", h.a.cookie);
    expect(unknown.body).toEqual(res.body);
    expect(await remaining(h.b)).toEqual([victimEvent]);
    const { rows } = await h.testDb.pool.query<{ status: string }>(
      "select status from integrations where id = $1",
      [h.b.integrationId],
    );
    expect(rows[0]?.status).toBe("active");
    expect((await h.testDb.pool.query("select 1 from bulk_deletions")).rowCount).toBe(0);
  });
});

describe("the worker process", () => {
  it("registers the queue and runs a deletion job", async () => {
    const worker = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(authTestConfig(h.testDb, { allowSignup: false }))
      .compile();
    await worker.init();
    try {
      expect(await boss.getQueue(BULK_DELETE_QUEUE)).not.toBeNull();
      await seed(h.a, { domain: "worker.example" });
      const keep = await seed(h.a, { domain: "kept.example" });
      const deletion = await startFilter(h.a, { domain: "worker.example" });
      await expect
        .poll(
          async () =>
            deletionResponseSchema.parse((await getDeletion(h.a, deletion.id)).body).deletion
              .status,
          { timeout: 30_000, interval: 250 },
        )
        .toBe("completed");
      expect(await remaining(h.a)).toEqual([keep]);
    } finally {
      await worker.close();
    }
  }, 60_000);
});
