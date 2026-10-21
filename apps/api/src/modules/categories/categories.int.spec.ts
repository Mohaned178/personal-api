/**
 * M9-07 category overrides over HTTP against the real application (Testcontainers; CI runs these,
 * Docker may be off locally), using the two-user fixture.
 *
 * Covers: CRUD with server-set ids, validation (400 without echoing input, nothing written), one
 * override per pattern (409), the per-user cap (409, also under concurrent creates), the session
 * requirement, and cross-tenant refusals (foreign, unknown and malformed ids answer the same 404).
 */
import type { INestApplication } from "@nestjs/common";
import {
  CATEGORY_RULES_PER_USER_MAX,
  categoryListResponseSchema,
  categoryRuleSchema,
} from "@personal-api/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tenantState } from "../../../test/adversarial-helpers";
import { FORMER_READ_KEY } from "../../../test/former-read-key";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { buildFixtureApp, type FixtureUser, seedTwoUsers } from "../../../test/two-user-fixture";

const PROBLEM_JSON = /^application\/problem\+json/;
const SENTINEL = "sentinel-domain-9c1e.example";
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
  await testDb.pool.query("truncate site_categories");
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

const rule = (overrides: Record<string, unknown> = {}) => ({
  pattern: "youtube.com",
  category: "productive",
  ...overrides,
});

async function create(user: FixtureUser, body: object = rule()) {
  const res = await as(user).post("/v1/categories", body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return categoryRuleSchema.parse(res.body);
}

describe("create, list, replace, delete", () => {
  it("creates an override with a server-set id and lists it with the built-in list", async () => {
    const created = await create(a, rule({ pattern: "*.reddit.com", category: "neutral" }));
    expect(created).toMatchObject({ pattern: "*.reddit.com", category: "neutral" });
    const res = await as(a).get("/v1/categories");
    expect(res.status).toBe(200);
    const listed = categoryListResponseSchema.parse(res.body);
    expect(listed.rules).toEqual([created]);
    expect(listed.presets.distracting).toContain("youtube.com");
    expect(listed.presets.productive).toContain("github.com");
  });

  it("lists the overrides by pattern", async () => {
    await create(a, rule({ pattern: "reddit.com" }));
    await create(a, rule({ pattern: "*.youtube.com" }));
    await create(a, rule({ pattern: "github.com" }));
    const res = await as(a).get("/v1/categories");
    expect(res.body.rules.map((r: { pattern: string }) => r.pattern)).toEqual([
      "*.youtube.com",
      "github.com",
      "reddit.com",
    ]);
  });

  it("replaces the whole override", async () => {
    const created = await create(a);
    const res = await as(a).put(`/v1/categories/${created.id}`, rule({ category: "distracting" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...created, category: "distracting" });
  });

  it("deletes an override with 204, then 404s", async () => {
    const created = await create(a);
    expect((await as(a).delete(`/v1/categories/${created.id}`)).status).toBe(204);
    const again = await as(a).delete(`/v1/categories/${created.id}`);
    expect(again.status).toBe(404);
    expect(again.body.code).toBe("category.not_found");
    expect((await as(a).get("/v1/categories")).body.rules).toEqual([]);
  });

  it("lets two users override the same pattern", async () => {
    await create(a);
    await create(b);
    expect((await as(a).get("/v1/categories")).body.rules).toHaveLength(1);
    expect((await as(b).get("/v1/categories")).body.rules).toHaveLength(1);
  });
});

describe("validation", () => {
  it.each([
    ["a missing pattern", { category: "neutral" }],
    ["a missing category", { pattern: "youtube.com" }],
    ["an unknown category", rule({ category: "evil" })],
    ["a url", rule({ pattern: `https://${SENTINEL}/path` })],
    ["a path", rule({ pattern: `${SENTINEL}/path` })],
    ["an uppercase domain", rule({ pattern: "YouTube.com" })],
    ["a user id", rule({ userId: "someone" })],
    ["an id", rule({ id: MISSING })],
  ])("rejects %s with 400 request.invalid and writes nothing", async (_label, body) => {
    const before = await tenantState(testDb.pool, a.userId);
    const res = await as(a).post("/v1/categories", body);
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("request.invalid");
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
    expect(await tenantState(testDb.pool, a.userId)).toEqual(before);
  });
});

describe("one override per pattern", () => {
  it("answers 409 category.pattern_taken for a second override on a pattern", async () => {
    await create(a);
    const res = await as(a).post("/v1/categories", rule({ category: "neutral" }));
    expect(res.status).toBe(409);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("category.pattern_taken");
    expect(JSON.stringify(res.body)).not.toContain("youtube");
  });

  it("answers 409 when a replacement takes another override's pattern", async () => {
    await create(a, rule({ pattern: "reddit.com" }));
    const other = await create(a);
    const res = await as(a).put(`/v1/categories/${other.id}`, rule({ pattern: "reddit.com" }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("category.pattern_taken");
  });
});

describe("the per-user cap", () => {
  const fill = (count: number) =>
    testDb.pool.query(
      `insert into site_categories (user_id, pattern, category)
         select $1, 'site' || n || '.example.com', 'neutral' from generate_series(1, $2::int) as n`,
      [a.userId, count],
    );

  it("answers 409 category.limit_reached at the cap", async () => {
    await fill(CATEGORY_RULES_PER_USER_MAX);
    const res = await as(a).post("/v1/categories", rule());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("category.limit_reached");
    await create(b);
  });

  it("never lets concurrent creates pass the cap", async () => {
    await fill(CATEGORY_RULES_PER_USER_MAX - 1);
    const results = await Promise.all(
      ["one", "two", "three", "four"].map((name) =>
        as(a).post("/v1/categories", rule({ pattern: `${name}.example.com` })),
      ),
    );
    expect(results.filter((res) => res.status === 201)).toHaveLength(1);
    expect(results.filter((res) => res.status === 409)).toHaveLength(3);
  });
});

describe("who may call", () => {
  const routes: Array<[string, (c: ReturnType<typeof http>) => request.Test]> = [
    ["GET /v1/categories", (c) => c.get("/v1/categories")],
    ["POST /v1/categories", (c) => c.post("/v1/categories").send(rule())],
    ["PUT /v1/categories/:id", (c) => c.put(`/v1/categories/${MISSING}`).send(rule())],
    ["DELETE /v1/categories/:id", (c) => c.delete(`/v1/categories/${MISSING}`)],
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
  it("never shows or changes another user's override, and a foreign id looks like an unknown one", async () => {
    const mine = await create(a);
    const theirs = await create(b, rule({ pattern: "theirs.example.com" }));
    const before = await tenantState(testDb.pool, b.userId);

    expect((await as(a).get("/v1/categories")).body.rules).toEqual([mine]);

    const unknownPut = await as(a).put(`/v1/categories/${MISSING}`, rule());
    const foreignPut = await as(a).put(
      `/v1/categories/${theirs.id}`,
      rule({ category: "neutral" }),
    );
    expect(foreignPut.status).toBe(404);
    expect(foreignPut.body).toEqual(unknownPut.body);

    const unknownDelete = await as(a).delete(`/v1/categories/${MISSING}`);
    const foreignDelete = await as(a).delete(`/v1/categories/${theirs.id}`);
    expect(foreignDelete.status).toBe(404);
    expect(foreignDelete.body).toEqual(unknownDelete.body);

    expect(await tenantState(testDb.pool, b.userId)).toEqual(before);
  });

  it("takes the owner from the session, never from the body, query or headers", async () => {
    const res = await as(a)
      .post(`/v1/categories?userId=${b.userId}`, rule())
      .set("X-User-Id", b.userId);
    expect(res.status).toBe(201);
    const { rows } = await testDb.pool.query("select user_id from site_categories where id = $1", [
      res.body.id,
    ]);
    expect(rows).toEqual([{ user_id: a.userId }]);
    expect((await as(b).get("/v1/categories")).body.rules).toEqual([]);
  });
});
