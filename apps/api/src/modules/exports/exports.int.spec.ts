/**
 * M6-05 data export against the real application (Testcontainers; CI runs these, Docker may be
 * off locally), with the two-user fixture and a fixed clock.
 *
 * The "done when" criteria below come from the task line (the plan has none):
 *  - `POST /v1/exports` answers 202 with a queued export; the job writes `events.ndjson.gz` (one
 *    `storedEventSchema` line per matching event of the caller, newest first) and a
 *    `manifest.json` that describes it (count, filter, sha256 and size of the gzip file);
 *  - a completed export is downloadable until `expiresAt`: 409 before it is ready, 410 after;
 *  - the cleanup job removes expired exports (files, then rows), failed ones, and directories that
 *    no row owns;
 *  - running a job twice, or retrying a failed one, is safe;
 *  - deleting the account removes the user's export files (and leaves the other user's alone);
 *  - another user's export id reaches nothing of theirs.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
  ACCOUNT_DELETE_CONFIRMATION,
  EXPORT_LIMIT_REACHED_CODE,
  EXPORT_MAX_ACTIVE,
  EXPORT_MAX_PER_DAY,
  EXPORT_TTL_HOURS,
  EXPORTS_CURSOR_INVALID_CODE,
  exportManifestSchema,
  exportResponseSchema,
  listExportsResponseSchema,
  storedEventSchema,
} from "@personal-api/contracts";
import type { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIXED_NOW,
  type IngestHarness,
  PROBLEM_JSON,
  startIngestHarness,
} from "../../../test/ingest-helpers";
import type { FixtureUser } from "../../../test/two-user-fixture";
import { PG_BOSS } from "../../platform/jobs/jobs.tokens";
import { EXPORT_CLEANUP_QUEUE, EXPORT_RUN_QUEUE } from "./exports.jobs";
import { ExportsRepository } from "./exports.repository";
import { ExportStorage } from "./exports.storage";
import { ExportsCleanupService } from "./exports-cleanup.service";
import { ExportsRunService } from "./exports-run.service";

let h: IngestHarness;
let boss: PgBoss;
let runner: ExportsRunService;
let cleanup: ExportsCleanupService;
let storage: ExportStorage;

beforeAll(async () => {
  h = await startIngestHarness();
  boss = h.app.get<PgBoss>(PG_BOSS);
  runner = h.app.get(ExportsRunService);
  cleanup = h.app.get(ExportsCleanupService);
  storage = h.app.get(ExportStorage);
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.reset();
  await boss.deleteAllJobs(EXPORT_RUN_QUEUE);
  await boss.deleteAllJobs(EXPORT_CLEANUP_QUEUE);
  for (const id of await storage.listIds()) await storage.remove(id);
});

const T0 = Date.parse(FIXED_NOW);
const at = (minutesAgo: number) => new Date(T0 - minutesAgo * 60_000).toISOString();

const http = () => request(h.app.getHttpServer());
const create = (u: FixtureUser, body: unknown = {}) =>
  http()
    .post("/v1/exports")
    .set("Cookie", u.cookie)
    .send(body as object);
const getExport = (u: FixtureUser, id: string) =>
  http().get(`/v1/exports/${id}`).set("Cookie", u.cookie);
const download = (u: FixtureUser, id: string) =>
  http()
    .get(`/v1/exports/${id}/download`)
    .set("Cookie", u.cookie)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });
const manifestOf = (u: FixtureUser, id: string) =>
  http().get(`/v1/exports/${id}/manifest`).set("Cookie", u.cookie);

async function seed(
  user: FixtureUser,
  options: { minutesAgo?: number; type?: string; domain?: string } = {},
): Promise<string> {
  const { rows } = await h.testDb.pool.query<{ id: string }>(
    `insert into events (user_id, integration_id, client_event_id, type, type_version, occurred_at, data, tags)
     values ($1, $2, $3, $4, 1, $5, $6::jsonb, '{work}') returning id`,
    [
      user.userId,
      user.integrationId,
      randomUUID(),
      options.type ?? "browser.page_visited",
      at(options.minutesAgo ?? 0),
      JSON.stringify({ domain: options.domain ?? "example.com", path: "/" }),
    ],
  );
  return (rows[0] as { id: string }).id;
}

/** Starts an export through the route and returns its id. */
async function start(user: FixtureUser, filter?: object): Promise<string> {
  const res = await create(user, filter ? { filter } : {});
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return exportResponseSchema.parse(res.body).export.id;
}

/** The lines of a downloaded events file, each checked against the contract. */
function lines(file: Buffer) {
  const text = gunzipSync(file).toString("utf8");
  if (text === "") return [];
  expect(text.endsWith("\n")).toBe(true);
  return text
    .trimEnd()
    .split("\n")
    .map((line) => storedEventSchema.parse(JSON.parse(line)));
}

describe("POST /v1/exports", () => {
  it("answers 202 with a queued export and enqueues one job that carries ids only", async () => {
    await seed(h.a);
    const res = await create(h.a, { filter: { domain: "example.com" } });
    expect(res.status).toBe(202);
    const created = exportResponseSchema.parse(res.body).export;
    expect(created).toMatchObject({
      status: "queued",
      filter: { domain: "example.com" },
      eventCount: null,
      sizeBytes: null,
      finishedAt: null,
      expiresAt: null,
    });
    expect(JSON.stringify(res.body)).not.toContain(h.a.userId);
    const { rows } = await h.testDb.pool.query<{ data: unknown }>(
      "select data from pgboss.job where name = $1",
      [EXPORT_RUN_QUEUE],
    );
    expect(rows.map((r) => r.data)).toEqual([{ userId: h.a.userId, exportId: created.id }]);
    expect(existsSync(storage.dir(created.id))).toBe(false);
  });

  it("refuses unknown keys, a user id and a bad filter with 400, and creates nothing", async () => {
    for (const body of [
      { userId: h.b.userId },
      { filter: { userId: h.b.userId } },
      { filter: { source: "not-a-uuid" } },
      { filter: { from: "yesterday" } },
      { nope: true },
    ]) {
      const res = await create(h.a, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe("request.invalid");
      expect(JSON.stringify(res.body)).not.toContain(h.b.userId);
    }
    expect((await h.testDb.pool.query("select 1 from exports")).rowCount).toBe(0);
  });
});

describe("the export job", () => {
  it("writes the caller's events as validated NDJSON.gz plus a manifest that describes it", async () => {
    const { a, b } = h;
    const newest = await seed(a, { minutesAgo: 1 });
    const oldest = await seed(a, { minutesAgo: 30, type: "browser.tab_opened" });
    const bEvent = await seed(b);
    const id = await start(a);

    expect(await runner.run(a.userId, id)).toBe(2);

    const done = exportResponseSchema.parse((await getExport(a, id)).body).export;
    expect(done).toMatchObject({ status: "completed", eventCount: 2 });
    expect(done.finishedAt).toBe(FIXED_NOW);
    expect(done.expiresAt).toBe(new Date(T0 + EXPORT_TTL_HOURS * 3_600_000).toISOString());

    const file = await download(a, id);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toMatch(/application\/gzip/);
    expect(file.headers["content-disposition"]).toContain("events.ndjson.gz");
    const exported = lines(file.body as Buffer);
    expect(exported.map((e) => e.id)).toEqual([newest, oldest]);
    expect(exported.map((e) => e.id)).not.toContain(bEvent);
    expect(exported[0]).toMatchObject({ tags: ["work"], data: { domain: "example.com" } });

    const manifest = exportManifestSchema.parse((await manifestOf(a, id)).body);
    expect(manifest).toMatchObject({ exportId: id, eventCount: 2, filter: {} });
    expect(manifest.generatedAt).toBe(FIXED_NOW);
    expect(manifest.file.bytes).toBe((file.body as Buffer).length);
    expect(manifest.file.sha256).toBe(
      createHash("sha256")
        .update(file.body as Buffer)
        .digest("hex"),
    );
    expect(done.sizeBytes).toBe(manifest.file.bytes);
    expect(existsSync(`${storage.file(id, "events.ndjson.gz")}.tmp`)).toBe(false);
  });

  it("applies the filter, and an empty result is a valid empty file", async () => {
    const { a } = h;
    const hit = await seed(a, { minutesAgo: 30, type: "browser.tab_opened", domain: "x.example" });
    await seed(a, { minutesAgo: 5, type: "browser.tab_opened", domain: "x.example" });
    await seed(a, { minutesAgo: 90, type: "browser.tab_opened", domain: "x.example" });
    await seed(a, { minutesAgo: 30, type: "browser.page_visited", domain: "x.example" });
    const id = await start(a, {
      source: a.integrationId,
      type: "browser.tab_opened",
      domain: "x.example",
      from: at(60),
      to: at(10),
    });
    await runner.run(a.userId, id);
    expect(lines((await download(a, id)).body as Buffer).map((e) => e.id)).toEqual([hit]);

    const none = await start(a, { domain: "nothing.example" });
    expect(await runner.run(a.userId, none)).toBe(0);
    expect(lines((await download(a, none)).body as Buffer)).toEqual([]);
    expect(exportManifestSchema.parse((await manifestOf(a, none)).body).eventCount).toBe(0);
  });

  it("reads in several pages and loses nothing at the page edges", async () => {
    const { a } = h;
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await seed(a, { minutesAgo: i }));
    // Two events at the same instant: the id breaks the tie.
    ids.push(await seed(a, { minutesAgo: 3 }));
    const id = await start(a);
    expect(await runner.run(a.userId, id, { batchSize: 3 })).toBe(8);
    const exported = lines((await download(a, id)).body as Buffer).map((e) => e.id);
    expect(exported.sort()).toEqual([...ids].sort());
    expect(new Set(exported).size).toBe(8);
  });

  it("is idempotent: a second run leaves a completed export alone; a failed one runs again", async () => {
    const { a } = h;
    await seed(a);
    const id = await start(a);
    expect(await runner.run(a.userId, id)).toBe(1);
    const first = (await download(a, id)).body as Buffer;
    expect(await runner.run(a.userId, id)).toBe(0);
    expect((await download(a, id)).body).toEqual(first);

    await h.testDb.pool.query("update exports set status = 'failed' where id = $1", [id]);
    expect(await runner.run(a.userId, id)).toBe(1);
    expect(exportResponseSchema.parse((await getExport(a, id)).body).export.status).toBe(
      "completed",
    );
  });

  it("marks the export failed, removes its files and rethrows when it cannot run", async () => {
    const { a } = h;
    const id = await start(a);
    await h.testDb.pool.query(
      `update exports set filter = '{"bogus": true}'::jsonb where id = $1`,
      [id],
    );
    await expect(runner.run(a.userId, id)).rejects.toThrow();
    const { rows } = await h.testDb.pool.query<{ status: string }>(
      "select status from exports where id = $1",
      [id],
    );
    expect(rows[0]?.status).toBe("failed");
    expect(existsSync(storage.dir(id))).toBe(false);
    const res = await download(a, id);
    expect(res.status).toBe(409);
  });
});

describe("downloading", () => {
  it("answers 409 export.not_ready before the job has run", async () => {
    const id = await start(h.a);
    for (const path of ["download", "manifest"]) {
      const res = await http().get(`/v1/exports/${id}/${path}`).set("Cookie", h.a.cookie);
      expect(res.status).toBe(409);
      expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe("export.not_ready");
    }
  });

  it("answers 410 export.expired once the window has closed, and while the file is still there", async () => {
    await seed(h.a);
    const id = await start(h.a);
    await runner.run(h.a.userId, id);
    expect((await download(h.a, id)).status).toBe(200);

    h.clock.set(new Date(T0 + EXPORT_TTL_HOURS * 3_600_000).toISOString());
    for (const path of ["download", "manifest"]) {
      const res = await http().get(`/v1/exports/${id}/${path}`).set("Cookie", h.a.cookie);
      expect(res.status).toBe(410);
      expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe("export.expired");
    }
    // The row still exists until the cleanup runs, and still says when it expired.
    expect(exportResponseSchema.parse((await getExport(h.a, id)).body).export.status).toBe(
      "completed",
    );
  });

  it("answers 410 when the file has gone missing", async () => {
    const id = await start(h.a);
    await runner.run(h.a.userId, id);
    await storage.remove(id);
    expect((await download(h.a, id)).status).toBe(410);
  });

  it("lists the caller's exports, newest first, and nobody else's", async () => {
    const first = await start(h.a);
    const second = await start(h.a);
    await start(h.b);
    const res = await http().get("/v1/exports").set("Cookie", h.a.cookie);
    expect(res.status).toBe(200);
    const listed = listExportsResponseSchema.parse(res.body).exports;
    expect(listed.map((e) => e.id).sort()).toEqual([first, second].sort());
  });
});

describe("the cleanup job", () => {
  it("removes expired exports (files, then rows) and keeps the ones still in their window", async () => {
    const { a, b } = h;
    await seed(a);
    const old = await start(a);
    await runner.run(a.userId, old);
    h.clock.set(new Date(T0 + 2 * 3_600_000).toISOString());
    const fresh = await start(b);
    await runner.run(b.userId, fresh);

    h.clock.set(new Date(T0 + EXPORT_TTL_HOURS * 3_600_000 + 60_000).toISOString());
    expect(await cleanup.run()).toBe(1);

    expect(existsSync(storage.dir(old))).toBe(false);
    expect(existsSync(storage.dir(fresh))).toBe(true);
    expect((await getExport(a, old)).status).toBe(404);
    expect((await getExport(b, fresh)).status).toBe(200);
    expect(await cleanup.run()).toBe(0);
  });

  it("removes failed and stuck exports once they are older than the window", async () => {
    const { a } = h;
    const failed = await start(a);
    await h.testDb.pool.query(
      `update exports set filter = '{"bogus": true}'::jsonb where id = $1`,
      [failed],
    );
    await expect(runner.run(a.userId, failed)).rejects.toThrow();
    const queued = await start(a);

    // created_at is the database clock's, not the fake one: put it on the fake timeline.
    await h.testDb.pool.query("update exports set created_at = $1", [FIXED_NOW]);

    expect(await cleanup.run()).toBe(0);
    h.clock.set(new Date(T0 + EXPORT_TTL_HOURS * 3_600_000 + 60_000).toISOString());
    expect(await cleanup.run()).toBe(2);
    expect((await h.testDb.pool.query("select 1 from exports")).rowCount).toBe(0);
    expect(queued).not.toBe(failed);
  });

  it("removes a directory that no row owns, and leaves files that are not export directories", async () => {
    const orphan = randomUUID();
    await mkdir(storage.dir(orphan), { recursive: true });
    await writeFile(storage.file(orphan, "events.ndjson.gz"), "x");
    const id = await start(h.a);
    await runner.run(h.a.userId, id);

    expect(await cleanup.run()).toBe(1);
    expect(existsSync(storage.dir(orphan))).toBe(false);
    expect(existsSync(storage.dir(id))).toBe(true);
  });
});

describe("per-user limits", () => {
  const HOUR = 3_600_000;
  const insertExport = (user: FixtureUser, status: string, createdAt: string) =>
    h.testDb.pool.query(
      "insert into exports (user_id, status, filter, created_at) values ($1, $2, '{}'::jsonb, $3)",
      [user.userId, status, createdAt],
    );
  const count = async (user: FixtureUser) =>
    (await h.testDb.pool.query("select 1 from exports where user_id = $1", [user.userId])).rowCount;
  const jobs = async () =>
    (await h.testDb.pool.query("select 1 from pgboss.job where name = $1", [EXPORT_RUN_QUEUE]))
      .rowCount;

  it(`refuses a new export with 429 export.limit_reached while ${EXPORT_MAX_ACTIVE} are queued or running`, async () => {
    const { a } = h;
    await insertExport(a, "queued", at(5));
    await insertExport(a, "running", at(4));
    expect((await create(a)).status).toBe(202);
    const jobsBefore = await jobs();

    const refused = await create(a);
    expect(refused.status).toBe(429);
    expect(refused.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(refused.body.code).toBe(EXPORT_LIMIT_REACHED_CODE);
    expect(JSON.stringify(refused.body)).not.toContain(a.userId);
    expect(await count(a)).toBe(EXPORT_MAX_ACTIVE);
    expect(await jobs()).toBe(jobsBefore);
  });

  it("frees a slot once an export completes or fails", async () => {
    const { a } = h;
    await seed(a);
    const first = await start(a);
    await start(a);
    await start(a);
    expect((await create(a)).status).toBe(429);

    await runner.run(a.userId, first);
    expect((await create(a)).status).toBe(202);
    expect((await create(a)).status).toBe(429);

    await h.testDb.pool.query(
      "update exports set status = 'failed' where id = (select id from exports where user_id = $1 and status = 'queued' limit 1)",
      [a.userId],
    );
    expect((await create(a)).status).toBe(202);
  });

  it(`refuses the ${EXPORT_MAX_PER_DAY + 1}th export created within 24 hours, and counts only those`, async () => {
    const { a } = h;
    for (let i = 0; i < EXPORT_MAX_PER_DAY - 1; i++) {
      await insertExport(a, i % 2 === 0 ? "completed" : "failed", at(60 + i));
    }
    // Exactly 24 hours ago is outside the window, and so is anything older.
    await insertExport(a, "completed", new Date(T0 - 24 * HOUR).toISOString());
    await insertExport(a, "completed", new Date(T0 - 30 * HOUR).toISOString());

    expect((await create(a)).status).toBe(202);
    const refused = await create(a);
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe(EXPORT_LIMIT_REACHED_CODE);

    // A day later the old ones no longer count.
    h.clock.set(new Date(T0 + 25 * HOUR).toISOString());
    await h.testDb.pool.query("update exports set status = 'completed'");
    expect((await create(a)).status).toBe(202);
  });

  it("does not count another user's exports", async () => {
    const { a, b } = h;
    for (let i = 0; i < EXPORT_MAX_PER_DAY; i++) await insertExport(b, "queued", at(i));
    expect((await create(b)).status).toBe(429);

    expect((await create(a)).status).toBe(202);
    expect(await count(a)).toBe(1);
    expect(await count(b)).toBe(EXPORT_MAX_PER_DAY);
  });
});

describe("GET /v1/exports pagination", () => {
  const insertExport = async (user: FixtureUser, createdAt: string): Promise<string> => {
    const { rows } = await h.testDb.pool.query<{ id: string }>(
      "insert into exports (user_id, status, filter, created_at) values ($1, 'completed', '{}'::jsonb, $2) returning id",
      [user.userId, createdAt],
    );
    return (rows[0] as { id: string }).id;
  };
  const list = (u: FixtureUser, query = "") =>
    http().get(`/v1/exports${query}`).set("Cookie", u.cookie);

  it("pages newest first with a keyset cursor, without gaps or repeats", async () => {
    const { a, b } = h;
    const ids = [
      await insertExport(a, at(30)),
      await insertExport(a, at(20)),
      await insertExport(a, at(10)),
    ];
    const bId = await insertExport(b, at(25));

    const first = await list(a, "?limit=2");
    expect(first.status).toBe(200);
    const page1 = listExportsResponseSchema.parse(first.body);
    expect(page1.exports.map((e) => e.id)).toEqual([ids[2], ids[1]]);
    expect(page1.nextCursor).toEqual(expect.any(String));

    const second = listExportsResponseSchema.parse(
      (await list(a, `?limit=2&cursor=${page1.nextCursor}`)).body,
    );
    expect(second.exports.map((e) => e.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();

    // Without a limit everything fits on one page.
    const all = listExportsResponseSchema.parse((await list(a)).body);
    expect(all.exports.map((e) => e.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(all.nextCursor).toBeNull();

    // A cursor taken from A's list shows B only B's own exports.
    const cross = listExportsResponseSchema.parse(
      (await list(b, `?cursor=${page1.nextCursor}`)).body,
    );
    expect(cross.exports.map((e) => e.id)).toEqual([bId]);
  });

  it("breaks ties between exports created at the same time by id", async () => {
    const { a } = h;
    const ids = [
      await insertExport(a, at(5)),
      await insertExport(a, at(5)),
      await insertExport(a, at(5)),
    ];
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const page = listExportsResponseSchema.parse(
        (await list(a, `?limit=1${cursor ? `&cursor=${cursor}` : ""}`)).body,
      );
      seen.push(...page.exports.map((e) => e.id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual([...ids].sort().reverse());
  });

  it("answers 400 for a cursor this API did not issue, and for a bad limit", async () => {
    const forged = Buffer.from(JSON.stringify(["not a date", "not an id"])).toString("base64url");
    const wrongShape = Buffer.from(JSON.stringify({ a: 1 })).toString("base64url");
    for (const cursor of ["abc", forged, wrongShape]) {
      const res = await list(h.a, `?cursor=${cursor}`);
      expect(res.status, cursor).toBe(400);
      expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe(EXPORTS_CURSOR_INVALID_CODE);
    }
    for (const query of ["?limit=0", "?limit=51", "?limit=x", "?userId=abc"]) {
      const res = await list(h.a, query);
      expect(res.status, query).toBe(400);
      expect(res.body.code).toBe("request.invalid");
    }
  });
});

describe("an export that outlives its row", () => {
  it("removes the files it wrote when the account is deleted while the job runs", async () => {
    const { a } = h;
    await seed(a);
    const id = await start(a);
    // The runner holds its own repository instance (the jobs module provides it separately).
    const repository = (runner as unknown as { repository: ExportsRepository }).repository;
    const complete = repository.complete.bind(repository);
    // The account transaction removes the row right before the job records its result.
    const spy = vi.spyOn(repository, "complete").mockImplementation(async (...args) => {
      await h.testDb.pool.query("delete from exports where id = $1", [id]);
      return complete(...args);
    });
    try {
      await runner.run(a.userId, id);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(storage.dir(id))).toBe(false);
  });
});

describe("cross-tenant", () => {
  it("another user's export id is a 404 identical to an unknown one, on every route", async () => {
    await seed(h.a);
    const id = await start(h.a);
    await runner.run(h.a.userId, id);
    for (const suffix of ["", "/download", "/manifest"]) {
      const foreign = await http().get(`/v1/exports/${id}${suffix}`).set("Cookie", h.b.cookie);
      const unknown = await http()
        .get(`/v1/exports/${randomUUID()}${suffix}`)
        .set("Cookie", h.b.cookie);
      const malformed = await http()
        .get(`/v1/exports/not-a-uuid${suffix}`)
        .set("Cookie", h.b.cookie);
      for (const res of [foreign, unknown, malformed]) {
        expect(res.status, suffix).toBe(404);
        expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
        expect(res.body.code).toBe("export.not_found");
      }
      expect(foreign.body).toEqual(unknown.body);
    }
  });

  it("a filter naming the victim's integration exports nothing of the victim's", async () => {
    await seed(h.b);
    const id = await start(h.a, { source: h.b.integrationId });
    expect(await runner.run(h.a.userId, id)).toBe(0);
    expect(lines((await download(h.a, id)).body as Buffer)).toEqual([]);
  });

  it("a job whose payload names the wrong user finds no export and writes nothing", async () => {
    await seed(h.b);
    const id = await start(h.a);
    expect(await runner.run(h.b.userId, id)).toBe(0);
    expect(existsSync(storage.dir(id))).toBe(false);
  });

  it("needs a session on every route", async () => {
    const id = randomUUID();
    for (const [method, path] of [
      ["post", "/v1/exports"],
      ["get", "/v1/exports"],
      ["get", `/v1/exports/${id}`],
      ["get", `/v1/exports/${id}/download`],
      ["get", `/v1/exports/${id}/manifest`],
    ] as const) {
      const res = await http()[method](path);
      expect(res.status, path).toBe(401);
    }
  });
});

// Last: it deletes a fixture user, and the other tests share the fixture.
describe("account deletion", () => {
  it("removes the user's export files, and only theirs", async () => {
    const { a, b } = h;
    await seed(a);
    await seed(b);
    const aExport = await start(a);
    const aSecond = await start(a);
    const bExport = await start(b);
    for (const [user, id] of [
      [a, aExport],
      [a, aSecond],
      [b, bExport],
    ] as const) {
      await runner.run(user.userId, id);
    }
    const aFile = storage.file(aExport, "events.ndjson.gz");
    expect(existsSync(aFile)).toBe(true);
    expect(readFileSync(aFile).length).toBeGreaterThan(0);

    const res = await http()
      .delete("/v1/account")
      .set("Cookie", a.cookie)
      .send({ password: a.credentials.password, confirm: ACCOUNT_DELETE_CONFIRMATION });
    expect(res.status, JSON.stringify(res.body)).toBe(204);

    expect(existsSync(storage.dir(aExport))).toBe(false);
    expect(existsSync(storage.dir(aSecond))).toBe(false);
    expect(existsSync(storage.dir(bExport))).toBe(true);
    expect(
      (await h.testDb.pool.query("select 1 from exports where user_id = $1", [a.userId])).rowCount,
    ).toBe(0);
    expect((await getExport(b, bExport)).status).toBe(200);
  });
});
