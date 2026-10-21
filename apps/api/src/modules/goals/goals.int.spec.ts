/**
 * M9-07 goals over HTTP against the real application (Testcontainers; CI runs these, Docker may be
 * off locally), using the two-user fixture.
 *
 * Covers: set, replace, list and delete a goal per category, validation (400, nothing written), a
 * category a goal cannot have, the session requirement, and that one user never sees or changes
 * another user's goal.
 */
import type { INestApplication } from "@nestjs/common";
import { goalListResponseSchema } from "@personal-api/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tenantState } from "../../../test/adversarial-helpers";
import { FORMER_READ_KEY } from "../../../test/former-read-key";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { buildFixtureApp, type FixtureUser, seedTwoUsers } from "../../../test/two-user-fixture";

const PROBLEM_JSON = /^application\/problem\+json/;

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
  await testDb.pool.query("truncate category_goals");
  ({ a, b } = await seedTwoUsers(app, testDb));
});

const http = () => request(app.getHttpServer());
const as = (user: FixtureUser) => ({
  get: (path: string) => http().get(path).set("Cookie", user.cookie),
  put: (path: string, body?: unknown) =>
    http()
      .put(path)
      .set("Cookie", user.cookie)
      .send(body as object),
  delete: (path: string) => http().delete(path).set("Cookie", user.cookie),
});

describe("set, list, replace, delete", () => {
  it("sets a goal and lists it", async () => {
    const res = await as(a).put("/v1/goals/distracting", { minutes: 60 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ category: "distracting", minutes: 60 });
    const listed = await as(a).get("/v1/goals");
    expect(goalListResponseSchema.parse(listed.body).goals).toEqual([
      { category: "distracting", minutes: 60 },
    ]);
  });

  it("replaces the goal of a category instead of adding a second one", async () => {
    await as(a).put("/v1/goals/distracting", { minutes: 60 });
    await as(a).put("/v1/goals/distracting", { minutes: 45 });
    await as(a).put("/v1/goals/neutral", { minutes: 120 });
    const { goals } = (await as(a).get("/v1/goals")).body;
    expect(goals).toEqual([
      { category: "distracting", minutes: 45 },
      { category: "neutral", minutes: 120 },
    ]);
  });

  it("never lets concurrent sets leave two rows", async () => {
    await Promise.all(
      [30, 40, 50, 60].map((m) => as(a).put("/v1/goals/distracting", { minutes: m })),
    );
    const { rows } = await testDb.pool.query(
      "select count(*)::int as n from category_goals where user_id = $1",
      [a.userId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("deletes a goal with 204, then 404s", async () => {
    await as(a).put("/v1/goals/distracting", { minutes: 60 });
    expect((await as(a).delete("/v1/goals/distracting")).status).toBe(204);
    const again = await as(a).delete("/v1/goals/distracting");
    expect(again.status).toBe(404);
    expect(again.body.code).toBe("goal.not_found");
  });
});

describe("validation", () => {
  it.each([
    ["zero minutes", { minutes: 0 }],
    ["more than a day", { minutes: 1441 }],
    ["a fraction", { minutes: 1.5 }],
    ["no minutes", {}],
    ["a user id", { minutes: 60, userId: "someone" }],
  ])("rejects %s with 400 request.invalid and writes nothing", async (_label, body) => {
    const before = await tenantState(testDb.pool, a.userId);
    const res = await as(a).put("/v1/goals/distracting", body);
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("request.invalid");
    expect(await tenantState(testDb.pool, a.userId)).toEqual(before);
  });

  it.each(["productive", "unknown"])("a goal on %s is a 404 goal.not_found", async (category) => {
    const res = await as(a).put(`/v1/goals/${category}`, { minutes: 60 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("goal.not_found");
  });
});

describe("who may call", () => {
  const routes: Array<[string, (c: ReturnType<typeof http>) => request.Test]> = [
    ["GET /v1/goals", (c) => c.get("/v1/goals")],
    ["PUT /v1/goals/:category", (c) => c.put("/v1/goals/distracting").send({ minutes: 5 })],
    ["DELETE /v1/goals/:category", (c) => c.delete("/v1/goals/distracting")],
  ];

  it.each(routes)("%s refuses a call without a session with 401", async (_route, call) => {
    const res = await call(http());
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
  });

  it.each(routes)("%s refuses an ingest key and a former read key", async (_route, call) => {
    for (const key of [a.ingestKey, FORMER_READ_KEY]) {
      expect((await call(http()).set("Authorization", `Bearer ${key}`)).status).toBe(401);
    }
  });
});

describe("tenancy", () => {
  it("never shows or changes another user's goal", async () => {
    await as(a).put("/v1/goals/distracting", { minutes: 60 });
    await as(b).put("/v1/goals/distracting", { minutes: 15 });
    const before = await tenantState(testDb.pool, b.userId);

    expect((await as(a).get("/v1/goals")).body.goals).toEqual([
      { category: "distracting", minutes: 60 },
    ]);
    await as(a).put("/v1/goals/distracting", { minutes: 5 });
    expect((await as(a).delete("/v1/goals/neutral")).status).toBe(404);

    expect(await tenantState(testDb.pool, b.userId)).toEqual(before);
  });

  it("takes the owner from the session, never from the query or headers", async () => {
    const res = await as(a)
      .put(`/v1/goals/distracting?userId=${b.userId}`, { minutes: 60 })
      .set("X-User-Id", b.userId);
    expect(res.status).toBe(200);
    expect((await as(b).get("/v1/goals")).body.goals).toEqual([]);
  });
});
