/**
 * M9-06 focus API over HTTP against the real application (Testcontainers; CI runs these, Docker may
 * be off locally), using the two-user fixture.
 *
 * Covers: the server sets the end time (a body with `endsAt` or `userId` is a 400), a new session
 * replaces the running one, an ended session is not handed out, ending is idempotent, the session
 * requirement (401), and that one user never sees or ends another's session.
 */
import type { INestApplication } from "@nestjs/common";
import { focusResponseSchema } from "@personal-api/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { buildFixtureApp, type FixtureUser, seedTwoUsers } from "../../../test/two-user-fixture";

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
  await testDb.pool.query("truncate focus_sessions");
  ({ a, b } = await seedTwoUsers(app, testDb));
});

const http = () => request(app.getHttpServer());
const as = (user: FixtureUser) => ({
  get: () => http().get("/v1/focus").set("Cookie", user.cookie),
  post: (body: unknown) =>
    http()
      .post("/v1/focus")
      .set("Cookie", user.cookie)
      .send(body as object),
  delete: () => http().delete("/v1/focus").set("Cookie", user.cookie),
});

describe("focus session", () => {
  it("is empty until one is started", async () => {
    const res = await as(a).get();
    expect(res.status).toBe(200);
    expect(focusResponseSchema.parse(res.body)).toEqual({ session: null });
  });

  it("starts with a server end time about `minutes` from now, owned by the caller", async () => {
    const before = Date.now();
    const res = await as(a).post({ patterns: ["reddit.com", "*.youtube.com"], minutes: 45 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { session } = focusResponseSchema.parse(res.body);
    expect(session?.patterns).toEqual(["reddit.com", "*.youtube.com"]);
    const ends = Date.parse(session?.endsAt ?? "");
    expect(ends).toBeGreaterThanOrEqual(before + 45 * 60_000);
    expect(ends).toBeLessThanOrEqual(Date.now() + 45 * 60_000);
    const { rows } = await testDb.pool.query("select user_id from focus_sessions");
    expect(rows).toEqual([{ user_id: a.userId }]);
    expect(focusResponseSchema.parse((await as(a).get()).body).session?.id).toBe(session?.id);
  });

  it("replaces the running session", async () => {
    await as(a).post({ patterns: ["reddit.com"], minutes: 30 });
    const second = await as(a).post({ patterns: ["x.com"], minutes: 10 });
    expect(focusResponseSchema.parse(second.body).session?.patterns).toEqual(["x.com"]);
    const { rows } = await testDb.pool.query("select 1 from focus_sessions");
    expect(rows).toHaveLength(1);
  });

  it("does not hand out a session that has ended", async () => {
    await as(a).post({ patterns: ["reddit.com"], minutes: 30 });
    await testDb.pool.query("update focus_sessions set ends_at = now() - interval '1 second'");
    expect(focusResponseSchema.parse((await as(a).get()).body)).toEqual({ session: null });
  });

  it("ends with 204, and ending nothing is 204 too", async () => {
    await as(a).post({ patterns: ["reddit.com"], minutes: 30 });
    expect((await as(a).delete()).status).toBe(204);
    expect((await as(a).delete()).status).toBe(204);
    expect(focusResponseSchema.parse((await as(a).get()).body).session).toBeNull();
  });

  it.each([
    ["no sites", { patterns: [], minutes: 30 }],
    ["zero minutes", { patterns: ["x.com"], minutes: 0 }],
    ["an end time", { patterns: ["x.com"], minutes: 5, endsAt: "2030-01-01T00:00:00Z" }],
    ["an owner", { patterns: ["x.com"], minutes: 5, userId: "someone" }],
  ])("refuses %s with 400 request.invalid and writes nothing", async (_n, body) => {
    const res = await as(a).post(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("request.invalid");
    expect((await testDb.pool.query("select 1 from focus_sessions")).rows).toEqual([]);
  });
});

describe("session requirement", () => {
  it("answers 401 without a session on every route, and for an ingest key", async () => {
    for (const res of [
      await http().get("/v1/focus"),
      await http()
        .post("/v1/focus")
        .send({ patterns: ["x.com"], minutes: 5 }),
      await http().delete("/v1/focus"),
      await http().get("/v1/focus").set("Authorization", `Bearer ${a.ingestKey}`),
    ]) {
      expect(res.status).toBe(401);
    }
  });
});

describe("tenancy", () => {
  it("never shows or ends another user's session", async () => {
    await as(b).post({ patterns: ["theirs.example"], minutes: 30 });
    expect(focusResponseSchema.parse((await as(a).get()).body).session).toBeNull();
    expect((await as(a).delete()).status).toBe(204);
    expect(focusResponseSchema.parse((await as(b).get()).body).session?.patterns).toEqual([
      "theirs.example",
    ]);
  });

  it("starting a session leaves the other user's session alone", async () => {
    await as(b).post({ patterns: ["theirs.example"], minutes: 30 });
    await as(a).post({ patterns: ["mine.example"], minutes: 30 });
    expect(focusResponseSchema.parse((await as(b).get()).body).session?.patterns).toEqual([
      "theirs.example",
    ]);
  });
});
