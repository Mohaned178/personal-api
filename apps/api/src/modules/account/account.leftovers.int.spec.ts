/**
 * M6-06 what a job can still do after its account is gone (Testcontainers; CI runs these, Docker
 * may be off locally).
 *
 * `account.int.spec.ts` proves the rows, keys, queued jobs and export files of the deleted user
 * are gone, and that a bulk-deletion job already held by a worker finds nothing. This covers the
 * other two job handlers that carry a user id: an export run and a retention recompute that fire
 * after the deletion must not throw, must not write a file or a row, and must not touch the
 * other user, whose events the purge also leaves alone.
 */
import { existsSync } from "node:fs";
import type { INestApplication } from "@nestjs/common";
import { ACCOUNT_DELETE_CONFIRMATION, exportResponseSchema } from "@personal-api/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import { eventRows, FIXED_NOW, pageVisit, postEvents } from "../../../test/ingest-helpers";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { buildFixtureApp, type FixtureUser, seedTwoUsers } from "../../../test/two-user-fixture";
import { ExportStorage } from "../exports/exports.storage";
import { ExportsRunService } from "../exports/exports-run.service";
import { RetentionPurgeService } from "../retention/retention-purge.service";
import { RetentionRecomputeService } from "../retention/retention-recompute.service";

let testDb: TestDatabase;
let app: INestApplication;
const clock = new FakeClock(FIXED_NOW);
let a: FixtureUser;
let b: FixtureUser;

beforeAll(async () => {
  testDb = await startTestDatabase();
  app = await buildFixtureApp(testDb, { clock });
}, 240_000);

afterAll(async () => {
  await app?.close();
  await testDb?.stop();
});

/** Fresh users every test: each one deletes a. */
beforeEach(async () => {
  clock.set(FIXED_NOW);
  ({ a, b } = await seedTwoUsers(app, testDb));
  await testDb.pool.query("update integrations set default_policy = 'allow'");
});

const http = () => request(app.getHttpServer());

async function ingestOne(user: FixtureUser): Promise<void> {
  const res = await postEvents(app, user.ingestKey, [pageVisit()]);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function deleteAccount(user: FixtureUser): Promise<void> {
  const res = await http()
    .delete("/v1/account")
    .set("Cookie", user.cookie)
    .send({ password: user.credentials.password, confirm: ACCOUNT_DELETE_CONFIRMATION });
  expect(res.status, JSON.stringify(res.body)).toBe(204);
}

describe("a job that outlives its account", () => {
  it("an export run writes no file and no row, and the other user's export still runs", async () => {
    await ingestOne(a);
    await ingestOne(b);
    const started = async (user: FixtureUser) => {
      const res = await http().post("/v1/exports").set("Cookie", user.cookie).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      return exportResponseSchema.parse(res.body).export.id;
    };
    const aExport = await started(a);
    const bExport = await started(b);
    await deleteAccount(a);

    const runner = app.get(ExportsRunService);
    const storage = app.get(ExportStorage);
    expect(await runner.run(a.userId, aExport)).toBe(0);
    expect(existsSync(storage.dir(aExport))).toBe(false);
    expect(await storage.listIds()).not.toContain(aExport);
    expect(
      (await testDb.pool.query("select 1 from exports where user_id = $1", [a.userId])).rowCount,
    ).toBe(0);

    expect(await runner.run(b.userId, bExport)).toBe(1);
    expect(existsSync(storage.file(bExport, "events.ndjson.gz"))).toBe(true);
  });

  it("a recompute does nothing, and neither it nor the purge touches the other user's events", async () => {
    const put = await http()
      .put("/v1/retention/type/browser.page_visited")
      .set("Cookie", a.cookie)
      .send({ days: 7 });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    await ingestOne(a);
    await ingestOne(b);
    const bBefore = await eventRows(testDb.pool, b.userId);
    await deleteAccount(a);

    expect(await app.get(RetentionRecomputeService).run(a.userId)).toBe(0);
    clock.set(new Date(Date.parse(FIXED_NOW) + 8 * 86_400_000));
    expect(await app.get(RetentionPurgeService).run()).toBe(0);
    expect(await eventRows(testDb.pool, b.userId)).toEqual(bBefore);
    expect(await eventRows(testDb.pool, a.userId)).toEqual([]);
  });
});
