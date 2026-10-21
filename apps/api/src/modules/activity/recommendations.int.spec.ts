/**
 * M9-04 recommendations over HTTP against the real application (Testcontainers; CI runs these,
 * Docker may be off locally). Events are seeded with SQL so `occurred_at` and the durations are
 * exact. Fixed clock: FIXED_NOW (2026-10-14T12:00Z). The rules themselves are covered in
 * `recommendations.rules.spec.ts`; this checks the numbers the route feeds them and the scoping.
 */

import { randomUUID } from "node:crypto";
import { recommendationsResponseSchema } from "@personal-api/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FIXED_NOW, type IngestHarness, startIngestHarness } from "../../../test/ingest-helpers";
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
const get = (u: FixtureUser) => http().get("/v1/recommendations").set("Cookie", u.cookie);

async function seed(
  user: FixtureUser,
  domain: string,
  occurredAt: string,
  durationMs: number,
): Promise<void> {
  await h.testDb.pool.query(
    `insert into events (user_id, integration_id, client_event_id, type, type_version, occurred_at, data)
     values ($1, $2, $3, 'browser.focus_segment', 1, $4, $5::jsonb)`,
    [
      user.userId,
      user.integrationId,
      randomUUID(),
      occurredAt,
      JSON.stringify({ domain, path: "/", durationMs }),
    ],
  );
}

/** One 20-minute segment at `hour` o'clock on each of `days` days ending 2026-10-13, `perDay` of them. */
async function heavyUse(user: FixtureUser, domain: string, days: number, perDay: number, hour = 9) {
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.UTC(2026, 9, 13 - i));
    for (let n = 0; n < perDay; n++) {
      const at = new Date(day.getTime() + hour * 3_600_000 + n * 25 * 60_000);
      await seed(user, domain, at.toISOString(), 20 * 60_000);
    }
  }
}

describe("GET /v1/recommendations", () => {
  it("is 401 without a session", async () => {
    const res = await http().get("/v1/recommendations");
    expect(res.status).toBe(401);
  });

  it("suggests nothing for a user without activity", async () => {
    const res = await get(h.a);
    expect(res.status).toBe(200);
    const body = recommendationsResponseSchema.parse(res.body);
    expect(body.to).toBe(FIXED_NOW);
    expect(body.recommendations).toEqual([]);
  });

  it("suggests a stepped plan for a heavy site over four weeks", async () => {
    // 20 days of 4 x 20 minutes = 80 minutes a day, so the plan starts at 75.
    await heavyUse(h.a, "heavy.test", 20, 4);
    const body = recommendationsResponseSchema.parse((await get(h.a)).body);
    expect(body.recommendations).toEqual([
      { kind: "limit_plan", domain: "heavy.test", averageMinutes: 80, steps: [75, 60, 45] },
    ]);
  });

  it("suggests a late-night hint using the user's time zone", async () => {
    // 23:00 UTC is 08:00 in Tokyo (not night); 14:00 UTC is 23:00 in Tokyo (night).
    await heavyUse(h.a, "owl.test", 15, 2, 14);
    expect(recommendationsResponseSchema.parse((await get(h.a)).body).recommendations).toEqual([]);
    await http().patch("/v1/settings").set("Cookie", h.a.cookie).send({ timeZone: "Asia/Tokyo" });
    const body = recommendationsResponseSchema.parse((await get(h.a)).body);
    expect(body.timeZone).toBe("Asia/Tokyo");
    expect(body.recommendations).toEqual([
      { kind: "late_night", domain: "owl.test", sharePercent: 100, fromHour: 23, toHour: 7 },
    ]);
  });

  it("does not plan for a site that has a limit, and never reads another user's activity", async () => {
    await heavyUse(h.a, "heavy.test", 20, 4);
    await heavyUse(h.b, "other.test", 20, 4);
    const a = recommendationsResponseSchema.parse((await get(h.a)).body);
    expect(a.recommendations.map((r) => ("domain" in r ? r.domain : r.pattern))).toEqual([
      "heavy.test",
    ]);
    const b = recommendationsResponseSchema.parse((await get(h.b)).body);
    expect(b.recommendations.map((r) => ("domain" in r ? r.domain : r.pattern))).toEqual([
      "other.test",
    ]);

    const made = await http()
      .post("/v1/limits")
      .set("Cookie", h.a.cookie)
      .send({ pattern: "heavy.test", minutes: 75 });
    expect(made.status).toBe(201);
    expect(recommendationsResponseSchema.parse((await get(h.a)).body).recommendations).toEqual([]);
    // The other user's suggestion is unchanged by this user's limit.
    expect(recommendationsResponseSchema.parse((await get(h.b)).body).recommendations).toHaveLength(
      1,
    );
  });
});
