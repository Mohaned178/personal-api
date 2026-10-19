/**
 * M5-03 activity aggregates and the time zone setting, over HTTP against the real application
 * (Testcontainers; CI runs these, Docker may be off locally). Events are seeded with SQL so
 * `occurred_at` and the durations are exact. Fixed clock: FIXED_NOW (2026-10-14T12:00Z).
 */
import { randomUUID } from "node:crypto";
import {
  activityDailyResponseSchema,
  activityDomainsResponseSchema,
  FOCUS_SEGMENT_MAX_MS,
  settingsSchema,
} from "@personal-api/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FIXED_NOW,
  type IngestHarness,
  PROBLEM_JSON,
  startIngestHarness,
} from "../../../test/ingest-helpers";
import type { FixtureUser } from "../../../test/two-user-fixture";

let h: IngestHarness;

beforeAll(async () => {
  h = await startIngestHarness();
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.reset();
  await h.testDb.pool.query(`update "user" set time_zone = 'UTC'`);
});

const http = () => request(h.app.getHttpServer());
const get = (u: FixtureUser, path: string) => http().get(path).set("Cookie", u.cookie);

async function seed(
  user: FixtureUser,
  options: { occurredAt: string; type?: string; domain?: string; durationMs?: number },
): Promise<void> {
  const type = options.type ?? "browser.focus_segment";
  const data: Record<string, unknown> = { domain: options.domain ?? "example.com", path: "/" };
  if (type === "browser.focus_segment") data.durationMs = options.durationMs ?? 60_000;
  await h.testDb.pool.query(
    `insert into events (user_id, integration_id, client_event_id, type, type_version, occurred_at, data)
     values ($1, $2, $3, $4, 1, $5, $6::jsonb)`,
    [user.userId, user.integrationId, randomUUID(), type, options.occurredAt, JSON.stringify(data)],
  );
}
const visit = (u: FixtureUser, occurredAt: string, domain?: string) =>
  seed(u, { occurredAt, type: "browser.page_visited", ...(domain ? { domain } : {}) });

function expectProblem(
  res: { status: number; headers: Record<string, unknown>; body: { code?: string } },
  status: number,
  code: string,
) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(String(res.headers["content-type"])).toMatch(PROBLEM_JSON);
  expect(res.body.code).toBe(code);
}

const daily = (res: { body: unknown }) => activityDailyResponseSchema.parse(res.body);
const domains = (res: { body: unknown }) => activityDomainsResponseSchema.parse(res.body);

describe("GET /v1/activity/daily", () => {
  it("sums focus time and counts visits per day, oldest first, defaulting to the last 7 days", async () => {
    await seed(h.a, { occurredAt: "2026-10-13T09:00:00Z", durationMs: 60_000 });
    await seed(h.a, { occurredAt: "2026-10-13T10:00:00Z", durationMs: 120_000 });
    await visit(h.a, "2026-10-13T09:00:00Z");
    await seed(h.a, { occurredAt: "2026-10-12T10:00:00Z", durationMs: 30_000 });
    await seed(h.a, { occurredAt: "2026-10-01T10:00:00Z", durationMs: 99_000 }); // before the window
    const res = await get(h.a, "/v1/activity/daily");
    expect(res.status).toBe(200);
    const body = daily(res);
    expect(body.timeZone).toBe("UTC");
    expect(body.to).toBe(FIXED_NOW);
    expect(body.from).toBe("2026-10-07T12:00:00.000Z");
    expect(body.days).toEqual([
      { date: "2026-10-12", activeMs: 30_000, pageVisits: 0 },
      { date: "2026-10-13", activeMs: 180_000, pageVisits: 1 },
    ]);
  });

  it("cuts days in the time zone of the user", async () => {
    await seed(h.a, { occurredAt: "2026-10-13T23:30:00Z", durationMs: 60_000 });
    expect(daily(await get(h.a, "/v1/activity/daily")).days.map((d) => d.date)).toEqual([
      "2026-10-13",
    ]);
    await http().patch("/v1/settings").set("Cookie", h.a.cookie).send({ timeZone: "Asia/Tokyo" });
    const tokyo = daily(await get(h.a, "/v1/activity/daily"));
    expect(tokyo.timeZone).toBe("Asia/Tokyo");
    expect(tokyo.days).toEqual([{ date: "2026-10-14", activeMs: 60_000, pageVisits: 0 }]);
  });

  it("clamps a stored duration above the 30-minute maximum", async () => {
    await seed(h.a, { occurredAt: "2026-10-13T09:00:00Z", durationMs: 99_000_000 });
    expect(daily(await get(h.a, "/v1/activity/daily")).days[0]?.activeMs).toBe(
      FOCUS_SEGMENT_MAX_MS,
    );
  });

  it("counts only focus segments and page visits, from the caller only", async () => {
    await seed(h.a, { occurredAt: "2026-10-13T09:00:00Z", type: "browser.tab_opened" });
    await seed(h.b, { occurredAt: "2026-10-13T09:00:00Z", durationMs: 777_000 });
    expect(daily(await get(h.a, "/v1/activity/daily")).days).toEqual([]);
  });

  it("takes from (inclusive) and to (exclusive)", async () => {
    await seed(h.a, { occurredAt: "2026-10-13T00:00:00Z", durationMs: 1000 });
    await seed(h.a, { occurredAt: "2026-10-14T00:00:00Z", durationMs: 2000 });
    const res = await get(
      h.a,
      "/v1/activity/daily?from=2026-10-13T00:00:00.000Z&to=2026-10-14T00:00:00.000Z",
    );
    expect(daily(res).days).toEqual([{ date: "2026-10-13", activeMs: 1000, pageVisits: 0 }]);
  });

  it("refuses a bad range, an unknown key and a named user with a 400", async () => {
    const t = "2026-10-13T00:00:00.000Z";
    expectProblem(await get(h.a, `/v1/activity/daily?from=${t}&to=${t}`), 400, "request.invalid");
    expectProblem(
      await get(h.a, "/v1/activity/daily?from=2026-01-01T00:00:00.000Z"),
      400,
      "activity.range_invalid",
    );
    expectProblem(
      await get(h.a, "/v1/activity/daily?from=2026-11-01T00:00:00.000Z"),
      400,
      "activity.range_invalid",
    );
    expectProblem(
      await get(h.a, `/v1/activity/daily?userId=${h.b.userId}`),
      400,
      "request.invalid",
    );
    expectProblem(await get(h.a, "/v1/activity/daily?tz=UTC"), 400, "request.invalid");
  });

  it("needs a credential", async () => {
    expectProblem(await http().get("/v1/activity/daily"), 401, "auth.unauthenticated");
  });
});

describe("GET /v1/activity/domains", () => {
  it("ranks domains by active time, then visits, then name, and applies the limit", async () => {
    await seed(h.a, { occurredAt: "2026-10-13T09:00:00Z", domain: "slow.test", durationMs: 1000 });
    await seed(h.a, { occurredAt: "2026-10-13T09:00:00Z", domain: "long.test", durationMs: 9000 });
    await visit(h.a, "2026-10-13T09:00:00Z", "long.test");
    await visit(h.a, "2026-10-13T09:00:00Z", "b.test");
    await visit(h.a, "2026-10-13T09:00:00Z", "a.test");
    const body = domains(await get(h.a, "/v1/activity/domains"));
    expect(body.domains).toEqual([
      { domain: "long.test", activeMs: 9000, pageVisits: 1 },
      { domain: "slow.test", activeMs: 1000, pageVisits: 0 },
      { domain: "a.test", activeMs: 0, pageVisits: 1 },
      { domain: "b.test", activeMs: 0, pageVisits: 1 },
    ]);
    expect(domains(await get(h.a, "/v1/activity/domains?limit=2")).domains).toHaveLength(2);
    expectProblem(await get(h.a, "/v1/activity/domains?limit=0"), 400, "request.invalid");
  });

  it("never shows the domains of another user", async () => {
    await seed(h.b, { occurredAt: "2026-10-13T09:00:00Z", domain: "secret.test" });
    const res = await get(h.a, "/v1/activity/domains");
    expect(domains(res).domains).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain("secret.test");
  });
});

describe("activity with a read key", () => {
  async function mint(user: FixtureUser, body: object) {
    const res = await http().post("/v1/keys").set("Cookie", user.cookie).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.key as string;
  }
  const keyGet = (key: string, path: string) =>
    http().get(path).set("Authorization", `Bearer ${key}`);

  it("works with activity:read, for the data of the key owner only", async () => {
    await seed(h.a, { occurredAt: "2026-10-13T09:00:00Z", durationMs: 5000 });
    await seed(h.b, { occurredAt: "2026-10-13T09:00:00Z", durationMs: 700_000 });
    const key = await mint(h.a, { scopes: ["activity:read"] });
    expect(daily(await keyGet(key, "/v1/activity/daily")).days[0]?.activeMs).toBe(5000);
    expect(domains(await keyGet(key, "/v1/activity/domains")).domains[0]?.activeMs).toBe(5000);
  });

  it("needs the activity:read scope", async () => {
    const key = await mint(h.a, { scopes: ["events:read"] });
    expectProblem(await keyGet(key, "/v1/activity/daily"), 403, "auth.insufficient_scope");
    expectProblem(await keyGet(key, "/v1/activity/domains"), 403, "auth.insufficient_scope");
  });

  it("is narrowed by the types and sources of the key", async () => {
    await seed(h.a, { occurredAt: "2026-10-13T09:00:00Z", durationMs: 5000 });
    await visit(h.a, "2026-10-13T09:00:00Z");
    const visitsOnly = await mint(h.a, {
      scopes: ["activity:read"],
      restriction: { types: ["browser.page_visited"] },
    });
    expect(daily(await keyGet(visitsOnly, "/v1/activity/daily")).days).toEqual([
      { date: "2026-10-13", activeMs: 0, pageVisits: 1 },
    ]);
    const ownSource = await mint(h.a, {
      scopes: ["activity:read"],
      restriction: { sources: [h.a.integrationId], types: ["browser.focus_segment"] },
    });
    expect(daily(await keyGet(ownSource, "/v1/activity/daily")).days).toEqual([
      { date: "2026-10-13", activeMs: 5000, pageVisits: 0 },
    ]);
    // A source that is not the key owner's cannot be named in a key at all (404 at creation).
    const foreign = await http()
      .post("/v1/keys")
      .set("Cookie", h.a.cookie)
      .send({ scopes: ["activity:read"], restriction: { sources: [h.b.integrationId] } });
    expect(foreign.status).toBe(404);
  });
});

describe("/v1/settings", () => {
  const patch = (u: FixtureUser, body: unknown) =>
    http()
      .patch("/v1/settings")
      .set("Cookie", u.cookie)
      .send(body as object);

  it("defaults to UTC, saves a valid zone, and keeps it per user", async () => {
    expect(settingsSchema.parse((await get(h.a, "/v1/settings")).body)).toEqual({
      timeZone: "UTC",
    });
    const res = await patch(h.a, { timeZone: "Europe/Berlin" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timeZone: "Europe/Berlin" });
    expect((await get(h.a, "/v1/settings")).body).toEqual({ timeZone: "Europe/Berlin" });
    expect((await get(h.b, "/v1/settings")).body).toEqual({ timeZone: "UTC" });
  });

  it("refuses an unknown zone, an offset, extra keys and a body that names a user", async () => {
    for (const body of [
      { timeZone: "Mars/Olympus" },
      { timeZone: "+02:00" },
      { timeZone: "UTC", userId: h.b.userId },
      {},
    ]) {
      expectProblem(await patch(h.a, body), 400, "request.invalid");
    }
    expect((await get(h.a, "/v1/settings")).body).toEqual({ timeZone: "UTC" });
  });

  it("is dashboard-only: a read key is refused", async () => {
    const created = await http()
      .post("/v1/keys")
      .set("Cookie", h.a.cookie)
      .send({ scopes: ["events:read", "activity:read"] });
    const res = await http().get("/v1/settings").set("Authorization", `Bearer ${created.body.key}`);
    expectProblem(res, 401, "auth.unauthenticated");
    expectProblem(await http().get("/v1/settings"), 401, "auth.unauthenticated");
  });
});
