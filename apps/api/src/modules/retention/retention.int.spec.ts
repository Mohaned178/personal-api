/**
 * M6-01 retention policies over HTTP against the real application (Testcontainers; CI runs these,
 * Docker may be off locally), using the two-user fixture and a fixed clock.
 *
 * Covers: the policy routes (list, put, replace, delete), validation that never echoes input,
 * refusing another user's integration, and the effect at ingest: `expires_at` follows
 * set_retention > type > source > 90 days, and an event older than its own retention is rejected.
 */
import { retentionResponseSchema } from "@personal-api/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DAY_MS,
  eventRows,
  expectResults,
  FIXED_NOW,
  type IngestHarness,
  isoAt,
  PROBLEM_JSON,
  pageVisit,
  postEvents,
  setDefaultPolicy,
  startIngestHarness,
  statuses,
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
});

const http = () => request(h.app.getHttpServer());
const get = (u: FixtureUser) => http().get("/v1/retention").set("Cookie", u.cookie);
const put = (u: FixtureUser, path: string, body: unknown) =>
  http()
    .put(`/v1/retention/${path}`)
    .set("Cookie", u.cookie)
    .send(body as object);
const del = (u: FixtureUser, path: string) =>
  http().delete(`/v1/retention/${path}`).set("Cookie", u.cookie);

const TYPE = "browser.page_visited";

function expectProblem(
  res: { status: number; headers: Record<string, unknown>; body: { code?: string } },
  status: number,
  code: string,
) {
  expect(res.status).toBe(status);
  expect(String(res.headers["content-type"])).toMatch(PROBLEM_JSON);
  expect(res.body.code).toBe(code);
}

describe("the policy routes", () => {
  it("answer 401 without a session", async () => {
    for (const send of [
      () => http().get("/v1/retention"),
      () => http().put(`/v1/retention/type/${TYPE}`).send({ days: 5 }),
      () => http().delete(`/v1/retention/type/${TYPE}`),
    ]) {
      expectProblem(await send(), 401, "auth.unauthenticated");
    }
  });

  it("start with the 90-day default and no policies", async () => {
    const res = await get(h.a);
    expect(res.status).toBe(200);
    expect(retentionResponseSchema.parse(res.body)).toEqual({ defaultDays: 90, policies: [] });
  });

  it("create, replace, list (types first) and delete", async () => {
    const made = await put(h.a, `source/${h.a.integrationId}`, { days: 30 });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ scope: "source", target: h.a.integrationId, days: 30 });
    expect((await put(h.a, `type/${TYPE}`, { days: 7 })).status).toBe(200);
    expect((await put(h.a, `type/${TYPE}`, { days: 14 })).status).toBe(200);

    const list = retentionResponseSchema.parse((await get(h.a)).body);
    expect(list.policies.map((p) => [p.scope, p.target, p.days])).toEqual([
      ["type", TYPE, 14],
      ["source", h.a.integrationId, 30],
    ]);

    expect((await del(h.a, `type/${TYPE}`)).status).toBe(204);
    expectProblem(await del(h.a, `type/${TYPE}`), 404, "retention.target_not_found");
    expect(retentionResponseSchema.parse((await get(h.a)).body).policies).toHaveLength(1);
  });

  it("refuse bad input with 400 and store nothing, without echoing the input", async () => {
    const sentinel = "sentinel-target-9c1e";
    const bad: Array<[string, unknown, string]> = [
      [`type/${TYPE}`, { days: 0 }, "request.invalid"],
      [`type/${TYPE}`, { days: 3651 }, "request.invalid"],
      [`type/${TYPE}`, { days: 1.5 }, "request.invalid"],
      [`type/${TYPE}`, { days: 5, userId: h.b.userId }, "request.invalid"],
      [`type/${sentinel}`, { days: 5 }, "retention.target_invalid"],
      [`source/${sentinel}`, { days: 5 }, "retention.target_invalid"],
      [`${sentinel}/${TYPE}`, { days: 5 }, "retention.target_invalid"],
    ];
    for (const [path, body, code] of bad) {
      const res = await put(h.a, path, body);
      expectProblem(res, 400, code);
      expect(JSON.stringify(res.body)).not.toContain(sentinel);
      expect(JSON.stringify(res.body)).not.toContain(h.b.userId);
    }
    expect(retentionResponseSchema.parse((await get(h.a)).body).policies).toEqual([]);
  });

  it("answer 404 for another user's integration or an unknown one, and write nothing", async () => {
    for (const id of [h.b.integrationId, "0192f1c2-7c1e-7a3b-9f00-000000000000"]) {
      expectProblem(await put(h.a, `source/${id}`, { days: 5 }), 404, "retention.target_not_found");
    }
    expect(retentionResponseSchema.parse((await get(h.a)).body).policies).toEqual([]);
    expect(retentionResponseSchema.parse((await get(h.b)).body).policies).toEqual([]);
  });

  it("keep each user's policies to themselves", async () => {
    await put(h.a, `type/${TYPE}`, { days: 5 });
    expect(retentionResponseSchema.parse((await get(h.b)).body).policies).toEqual([]);
    expectProblem(await del(h.b, `type/${TYPE}`), 404, "retention.target_not_found");
    expect(retentionResponseSchema.parse((await get(h.a)).body).policies).toHaveLength(1);
  });
});

describe("at ingest", () => {
  const expiresAfterDays = async (userId: string) => {
    const [row] = await eventRows(h.testDb.pool, userId);
    return row?.expires_at === null || row === undefined
      ? null
      : (row.expires_at.getTime() - Date.parse(FIXED_NOW)) / DAY_MS;
  };

  it("expires_at follows the source policy, then the type policy over it", async () => {
    await setDefaultPolicy(h.testDb.pool, "allow");
    await put(h.a, `source/${h.a.integrationId}`, { days: 30 });
    await postEvents(h.app, h.a.ingestKey, [pageVisit()]);
    expect(await expiresAfterDays(h.a.userId)).toBe(30);

    await put(h.a, `type/${TYPE}`, { days: 7 });
    await postEvents(h.app, h.a.ingestKey, [pageVisit()]);
    const rows = await eventRows(h.testDb.pool, h.a.userId);
    expect(
      rows.map((r) => (r.expires_at?.getTime() ?? 0) - Date.parse(FIXED_NOW)).sort((x, y) => x - y),
    ).toEqual([7 * DAY_MS, 30 * DAY_MS]);
  });

  it("does not apply another user's policies", async () => {
    await setDefaultPolicy(h.testDb.pool, "allow");
    await put(h.a, `type/${TYPE}`, { days: 1 });
    await postEvents(h.app, h.b.ingestKey, [pageVisit()]);
    expect(await expiresAfterDays(h.b.userId)).toBe(90);
  });

  it("rejects an event older than its policy days as ingest.occurred_at_too_old", async () => {
    await setDefaultPolicy(h.testDb.pool, "allow");
    await put(h.a, `type/${TYPE}`, { days: 30 });
    const res = await postEvents(h.app, h.a.ingestKey, [
      pageVisit({ occurredAt: isoAt(FIXED_NOW, -30 * DAY_MS) }),
      pageVisit({ occurredAt: isoAt(FIXED_NOW, -30 * DAY_MS - 1) }),
    ]);
    expect(statuses(expectResults(res))).toEqual(["accepted", "rejected"]);
    expect(await eventRows(h.testDb.pool, h.a.userId)).toHaveLength(1);
  });
});
