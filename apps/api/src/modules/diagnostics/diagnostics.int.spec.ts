/**
 * M3-06 `GET /v1/diagnostics`: window, counters, last-seen and heartbeat, and the cross-tenant
 * behavior. Real application against Testcontainers (CI runs these; Docker may be off locally).
 */
import { diagnosticsResponseSchema } from "@personal-api/contracts";
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
});

const get = (u: FixtureUser, path: string) =>
  request(h.app.getHttpServer()).get(path).set("Cookie", u.cookie);

const HOUR = 3_600_000;
const currentHour = Math.floor(Date.parse(FIXED_NOW) / HOUR) * HOUR;

async function seedLog(user: FixtureUser, hoursAgo: number, accepted: number, rejected = 0) {
  await h.testDb.pool.query(
    `insert into ingestion_log (user_id, integration_id, bucket, accepted, rejected)
     values ($1, $2, $3, $4, $5)`,
    [user.userId, user.integrationId, new Date(currentHour - hoursAgo * HOUR), accepted, rejected],
  );
}

describe("GET /v1/diagnostics", () => {
  it("answers 401 without a session", async () => {
    const res = await request(h.app.getHttpServer()).get("/v1/diagnostics");
    expect(res.status).toBe(401);
    expect(String(res.headers["content-type"])).toMatch(PROBLEM_JSON);
  });

  it("returns the caller's counters and sources, and nothing of another user", async () => {
    const { a, b } = h;
    await seedLog(a, 0, 5, 1);
    await seedLog(a, 2, 3);
    await seedLog(b, 0, 99);
    await h.testDb.pool.query(
      "update integrations set last_seen_at = $2, last_heartbeat = $3::jsonb where id = $1",
      [
        a.integrationId,
        FIXED_NOW,
        JSON.stringify({
          queueDepth: 7,
          oldestQueuedAgeMs: 1000,
          droppedCount: 2,
          clientVersion: "0.1.0",
        }),
      ],
    );

    const res = await get(a, "/v1/diagnostics?hours=4");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = diagnosticsResponseSchema.parse(res.body);
    expect(body.ingestion).toHaveLength(4);
    expect(body.ingestion.at(-1)).toMatchObject({ accepted: 5, rejected: 1 });
    expect(body.ingestion[1]).toMatchObject({ accepted: 3 });
    expect(body.integrations).toHaveLength(1);
    expect(body.integrations[0]).toMatchObject({
      id: a.integrationId,
      lastSeenAt: FIXED_NOW,
      heartbeat: { queueDepth: 7, droppedCount: 2 },
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(b.userId);
    expect(text).not.toContain(b.integrationId);
  });

  it("rejects a user id or an out-of-range window with 400 request.invalid", async () => {
    const { a, b } = h;
    for (const q of [`userId=${b.userId}`, "hours=0", "hours=169", "hours=abc"]) {
      const res = await get(a, `/v1/diagnostics?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.code).toBe("request.invalid");
    }
  });
});
