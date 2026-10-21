/**
 * M9-02 limits API over HTTP against the real application (Testcontainers; CI runs these, Docker
 * may be off locally), using the two-user fixture.
 *
 * Covers: CRUD with ids and owners set by the server, validation on save (400 `request.invalid`
 * without echoing input, nothing written), one limit per pattern (409), the per-user cap (409),
 * the session requirement (401 for no session, for an ingest key and for a former read key), and
 * cross-tenant refusals (a foreign, an unknown and a malformed id answer the same 404).
 */
import type { INestApplication } from "@nestjs/common";
import {
  LIMIT_MAX_MINUTES,
  LIMITS_PER_USER_MAX,
  limitListResponseSchema,
  limitSchema,
} from "@personal-api/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tenantState } from "../../../test/adversarial-helpers";
import { FORMER_READ_KEY } from "../../../test/former-read-key";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { buildFixtureApp, type FixtureUser, seedTwoUsers } from "../../../test/two-user-fixture";

const PROBLEM_JSON = /^application\/problem\+json/;
const SENTINEL = "sentinel-domain-4d2f.example";
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
  await testDb.pool.query("truncate site_limits");
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

const limit = (overrides: Record<string, unknown> = {}) => ({
  pattern: "youtube.com",
  minutes: 30,
  strict: false,
  ...overrides,
});

async function create(user: FixtureUser, body: object = limit()) {
  const res = await as(user).post("/v1/limits", body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return limitSchema.parse(res.body);
}

describe("create, list, replace, delete", () => {
  it("creates a limit with a server-set id and lists it", async () => {
    const created = await create(a, limit({ pattern: "*.reddit.com", minutes: 15, strict: true }));
    expect(created).toMatchObject({ pattern: "*.reddit.com", minutes: 15, strict: true });
    const res = await as(a).get("/v1/limits");
    expect(res.status).toBe(200);
    expect(limitListResponseSchema.parse(res.body).limits).toEqual([created]);
  });

  it("lists the limits by pattern", async () => {
    await create(a, limit({ pattern: "reddit.com" }));
    await create(a, limit({ pattern: "*.youtube.com" }));
    await create(a, limit({ pattern: "github.com" }));
    const res = await as(a).get("/v1/limits");
    expect(res.body.limits.map((l: { pattern: string }) => l.pattern)).toEqual([
      "*.youtube.com",
      "github.com",
      "reddit.com",
    ]);
  });

  it("is not strict unless asked", async () => {
    const created = await as(a).post("/v1/limits", { pattern: "x.example.com", minutes: 5 });
    expect(created.status).toBe(201);
    expect(created.body.strict).toBe(false);
  });

  it("replaces the whole limit", async () => {
    const created = await create(a);
    const res = await as(a).put(`/v1/limits/${created.id}`, limit({ minutes: 90, strict: true }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...created, minutes: 90, strict: true });
  });

  it("deletes a limit with 204, then 404s", async () => {
    const created = await create(a);
    expect((await as(a).delete(`/v1/limits/${created.id}`)).status).toBe(204);
    const again = await as(a).delete(`/v1/limits/${created.id}`);
    expect(again.status).toBe(404);
    expect(again.body.code).toBe("limit.not_found");
    expect((await as(a).get("/v1/limits")).body.limits).toEqual([]);
  });

  it("lets two users have a limit on the same pattern", async () => {
    await create(a);
    await create(b);
    expect((await as(a).get("/v1/limits")).body.limits).toHaveLength(1);
    expect((await as(b).get("/v1/limits")).body.limits).toHaveLength(1);
  });
});

describe("validation", () => {
  it.each([
    ["a missing pattern", { minutes: 30 }],
    ["zero minutes", limit({ minutes: 0 })],
    ["more than a day", limit({ minutes: LIMIT_MAX_MINUTES + 1 })],
    ["a url", limit({ pattern: `https://${SENTINEL}/path` })],
    ["a path", limit({ pattern: `${SENTINEL}/path` })],
    ["an uppercase domain", limit({ pattern: "YouTube.com" })],
    ["a user id", limit({ userId: "someone" })],
    ["an id", limit({ id: MISSING })],
  ])("rejects %s with 400 request.invalid and writes nothing", async (_label, body) => {
    const before = await tenantState(testDb.pool, a.userId);
    const res = await as(a).post("/v1/limits", body);
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("request.invalid");
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
    expect(await tenantState(testDb.pool, a.userId)).toEqual(before);
  });

  it("rejects an invalid replacement and keeps the stored limit", async () => {
    const created = await create(a);
    const res = await as(a).put(`/v1/limits/${created.id}`, limit({ minutes: 0 }));
    expect(res.status).toBe(400);
    expect((await as(a).get("/v1/limits")).body.limits).toEqual([created]);
  });
});

describe("one limit per pattern", () => {
  it("answers 409 limit.pattern_taken for a second limit on a pattern", async () => {
    await create(a);
    const res = await as(a).post("/v1/limits", limit({ minutes: 5 }));
    expect(res.status).toBe(409);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("limit.pattern_taken");
    expect(JSON.stringify(res.body)).not.toContain("youtube");
    expect((await as(a).get("/v1/limits")).body.limits).toHaveLength(1);
  });

  it("answers 409 when a replacement takes another limit's pattern", async () => {
    await create(a, limit({ pattern: "reddit.com" }));
    const other = await create(a);
    const res = await as(a).put(`/v1/limits/${other.id}`, limit({ pattern: "reddit.com" }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("limit.pattern_taken");
  });

  it("lets a limit keep its own pattern when replaced", async () => {
    const created = await create(a);
    expect((await as(a).put(`/v1/limits/${created.id}`, limit({ minutes: 45 }))).status).toBe(200);
  });

  it("treats overlapping patterns as separate limits", async () => {
    await create(a, limit({ pattern: "youtube.com" }));
    await create(a, limit({ pattern: "*.youtube.com" }));
    expect((await as(a).get("/v1/limits")).body.limits).toHaveLength(2);
  });
});

describe("the per-user cap", () => {
  it("answers 409 limit.limit_reached at the cap, and still lets the user change a limit", async () => {
    await testDb.pool.query(
      `insert into site_limits (user_id, pattern, minutes)
         select $1, 'site' || n || '.example.com', 10 from generate_series(1, $2::int) as n`,
      [a.userId, LIMITS_PER_USER_MAX],
    );
    const res = await as(a).post("/v1/limits", limit());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("limit.limit_reached");
    const [first] = (await as(a).get("/v1/limits")).body.limits;
    expect(
      (await as(a).put(`/v1/limits/${first.id}`, limit({ pattern: first.pattern }))).status,
    ).toBe(200);
    // The other user is not affected.
    await create(b);
  });

  it("never lets concurrent creates pass the cap", async () => {
    await testDb.pool.query(
      `insert into site_limits (user_id, pattern, minutes)
         select $1, 'site' || n || '.example.com', 10 from generate_series(1, $2::int) as n`,
      [a.userId, LIMITS_PER_USER_MAX - 1],
    );
    const results = await Promise.all(
      ["one", "two", "three", "four"].map((name) =>
        as(a).post("/v1/limits", limit({ pattern: `${name}.example.com` })),
      ),
    );
    expect(results.filter((res) => res.status === 201)).toHaveLength(1);
    expect(results.filter((res) => res.status === 409)).toHaveLength(3);
    const { rows } = await testDb.pool.query(
      "select count(*)::int as n from site_limits where user_id = $1",
      [a.userId],
    );
    expect(rows[0].n).toBe(LIMITS_PER_USER_MAX);
  });
});

describe("who may call", () => {
  const routes: Array<[string, (c: ReturnType<typeof http>) => request.Test]> = [
    ["GET /v1/limits", (c) => c.get("/v1/limits")],
    ["POST /v1/limits", (c) => c.post("/v1/limits").send(limit())],
    ["PUT /v1/limits/:id", (c) => c.put(`/v1/limits/${MISSING}`).send(limit())],
    ["DELETE /v1/limits/:id", (c) => c.delete(`/v1/limits/${MISSING}`)],
  ];

  it.each(routes)("%s refuses a call without a session with 401", async (_route, call) => {
    const res = await call(http());
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
  });

  it.each(routes)("%s refuses an ingest key and a former read key", async (_route, call) => {
    for (const key of [a.ingestKey, FORMER_READ_KEY]) {
      const res = await call(http()).set("Authorization", `Bearer ${key}`);
      expect(res.status).toBe(401);
    }
  });
});

describe("tenancy", () => {
  it("never shows or changes another user's limit, and a foreign id looks like an unknown one", async () => {
    const mine = await create(a);
    const theirs = await create(b, limit({ pattern: "theirs.example.com" }));
    const before = await tenantState(testDb.pool, b.userId);

    expect((await as(a).get("/v1/limits")).body.limits).toEqual([mine]);

    const unknownPut = await as(a).put(`/v1/limits/${MISSING}`, limit());
    const foreignPut = await as(a).put(`/v1/limits/${theirs.id}`, limit({ minutes: 1 }));
    expect(foreignPut.status).toBe(404);
    expect(foreignPut.body.code).toBe("limit.not_found");
    expect(foreignPut.body).toEqual(unknownPut.body);

    const unknownDelete = await as(a).delete(`/v1/limits/${MISSING}`);
    const foreignDelete = await as(a).delete(`/v1/limits/${theirs.id}`);
    expect(foreignDelete.status).toBe(404);
    expect(foreignDelete.body).toEqual(unknownDelete.body);

    const malformed = await as(a).delete("/v1/limits/not-a-uuid");
    expect(malformed.status).toBe(404);
    expect(malformed.body).toEqual(unknownDelete.body);

    expect(await tenantState(testDb.pool, b.userId)).toEqual(before);
  });

  it("takes the owner from the session, never from the body, query or headers", async () => {
    const res = await as(a)
      .post(`/v1/limits?userId=${b.userId}`, limit())
      .set("X-User-Id", b.userId);
    expect(res.status).toBe(201);
    const { rows } = await testDb.pool.query("select user_id from site_limits where id = $1", [
      res.body.id,
    ]);
    expect(rows).toEqual([{ user_id: a.userId }]);
    expect((await as(b).get("/v1/limits")).body.limits).toEqual([]);
  });
});
