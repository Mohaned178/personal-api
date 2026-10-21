/**
 * M9-06 schedules API over HTTP against the real application (Testcontainers; CI runs these, Docker
 * may be off locally), using the two-user fixture.
 *
 * Covers: CRUD with ids and owners set by the server, validation on save (400 `request.invalid`
 * without echoing input, nothing written), the per-user cap (409), the session requirement (401),
 * and cross-tenant refusals (a foreign, an unknown and a malformed id answer the same 404).
 */
import type { INestApplication } from "@nestjs/common";
import {
  SCHEDULES_PER_USER_MAX,
  scheduleListResponseSchema,
  scheduleSchema,
} from "@personal-api/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { buildFixtureApp, type FixtureUser, seedTwoUsers } from "../../../test/two-user-fixture";

const PROBLEM_JSON = /^application\/problem\+json/;
const SENTINEL = "sentinel-domain-9b1e.example";
const MISSING = "0192f1c2-7c1e-7a3b-9f00-000000000000";

let testDb: TestDatabase;
let app: INestApplication;
let a: FixtureUser;
let b: FixtureUser;

beforeAll(async () => {
  testDb = await startTestDatabase();
  app = await buildFixtureApp(testDb);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await testDb?.stop();
});

beforeEach(async () => {
  await testDb.pool.query("truncate site_schedules");
  ({ a, b } = await seedTwoUsers(app, testDb));
});

const http = () => request(app.getHttpServer());
const as = (user: FixtureUser) => ({
  get: (path: string) => http().get(path).set("Cookie", user.cookie),
  post: (path: string, body?: unknown) =>
    http()
      .post(path)
      .set("Cookie", user.cookie)
      .send(body as object),
  put: (path: string, body?: unknown) =>
    http()
      .put(path)
      .set("Cookie", user.cookie)
      .send(body as object),
  delete: (path: string) => http().delete(path).set("Cookie", user.cookie),
});

const schedule = (overrides: Record<string, unknown> = {}) => ({
  name: "Work hours",
  patterns: ["reddit.com", "*.youtube.com"],
  days: [0, 1, 2, 3, 4],
  start: "09:00",
  end: "17:00",
  ...overrides,
});

async function create(user: FixtureUser, body: object = schedule()) {
  const res = await as(user).post("/v1/schedules", body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return scheduleSchema.parse(res.body);
}

describe("schedules CRUD", () => {
  it("creates with a server id, enabled by default, and lists by name", async () => {
    const night = await create(a, schedule({ name: "Night", start: "23:00", end: "07:00" }));
    const work = await create(a);
    expect(work.enabled).toBe(true);
    const res = await as(a).get("/v1/schedules");
    expect(res.status).toBe(200);
    const list = scheduleListResponseSchema.parse(res.body);
    expect(list.schedules.map((s) => s.id)).toEqual([night.id, work.id]);
    const { rows } = await testDb.pool.query("select user_id from site_schedules where id = $1", [
      work.id,
    ]);
    expect(rows).toEqual([{ user_id: a.userId }]);
  });

  it("replaces the whole schedule, including turning it off", async () => {
    const made = await create(a);
    const res = await as(a).put(
      `/v1/schedules/${made.id}`,
      schedule({ enabled: false, end: "18:30" }),
    );
    expect(res.status).toBe(200);
    expect(scheduleSchema.parse(res.body)).toMatchObject({
      id: made.id,
      enabled: false,
      end: "18:30",
    });
  });

  it("deletes with 204, then 404", async () => {
    const made = await create(a);
    expect((await as(a).delete(`/v1/schedules/${made.id}`)).status).toBe(204);
    const again = await as(a).delete(`/v1/schedules/${made.id}`);
    expect(again.status).toBe(404);
    expect(again.body.code).toBe("schedule.not_found");
  });

  it.each([
    ["equal times", { start: "09:00", end: "09:00" }],
    ["no days", { days: [] }],
    ["a url", { patterns: [`https://${SENTINEL}/a?b=c`] }],
    ["an id from the client", { id: MISSING }],
    ["an owner", { userId: "someone" }],
  ])(
    "refuses %s with a 400 that does not echo the input, and writes nothing",
    async (_n, change) => {
      const res = await as(a).post("/v1/schedules", schedule(change));
      expect(res.status).toBe(400);
      expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe("request.invalid");
      expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
      const { rows } = await testDb.pool.query("select 1 from site_schedules");
      expect(rows).toEqual([]);
    },
  );

  it("refuses a schedule past the per-user cap with 409 schedule.limit_reached", async () => {
    for (let i = 0; i < SCHEDULES_PER_USER_MAX; i++) await create(a, schedule({ name: `s${i}` }));
    const res = await as(a).post("/v1/schedules", schedule({ name: "one too many" }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("schedule.limit_reached");
    expect((await as(b).post("/v1/schedules", schedule())).status).toBe(201);
  });
});

describe("session requirement", () => {
  it("answers 401 without a session on every route", async () => {
    for (const res of [
      await http().get("/v1/schedules"),
      await http().post("/v1/schedules").send(schedule()),
      await http().put(`/v1/schedules/${MISSING}`).send(schedule()),
      await http().delete(`/v1/schedules/${MISSING}`),
    ]) {
      expect(res.status).toBe(401);
    }
  });

  it("does not accept an ingest key", async () => {
    const res = await http().get("/v1/schedules").set("Authorization", `Bearer ${a.ingestKey}`);
    expect(res.status).toBe(401);
  });
});

describe("tenancy", () => {
  it("lists only the caller's schedules", async () => {
    await create(a, schedule({ name: "mine" }));
    await create(b, schedule({ name: "theirs" }));
    const res = await as(a).get("/v1/schedules");
    expect(res.body.schedules.map((s: { name: string }) => s.name)).toEqual(["mine"]);
  });

  it("answers a foreign, an unknown and a malformed id with the same 404", async () => {
    const theirs = await create(b);
    const results = [
      await as(a).put(`/v1/schedules/${theirs.id}`, schedule()),
      await as(a).put(`/v1/schedules/${MISSING}`, schedule()),
      await as(a).put("/v1/schedules/not-a-uuid", schedule()),
      await as(a).delete(`/v1/schedules/${theirs.id}`),
      await as(a).delete(`/v1/schedules/${MISSING}`),
    ];
    for (const res of results) {
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("schedule.not_found");
    }
    expect((await as(b).get("/v1/schedules")).body.schedules).toHaveLength(1);
  });
});
