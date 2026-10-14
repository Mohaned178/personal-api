/**
 * M1-06 heartbeat: stores last_heartbeat on the caller's integration only, bumps last_seen_at at
 * most once per interval (heartbeat and successful ingest), unknown keys are 400 request.invalid,
 * a revoked key is 401. Fixed clock throughout.
 */
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FIXED_NOW,
  type IngestHarness,
  PROBLEM_JSON,
  pageVisit,
  postEvents,
  startIngestHarness,
} from "../../../test/ingest-helpers";
import { LAST_SEEN_UPDATE_INTERVAL_MS } from "./ingest.service";

const HEARTBEAT_PATH = "/v1/ingest/heartbeat";
const heartbeat = {
  queueDepth: 4,
  oldestQueuedAgeMs: 2500,
  droppedCount: 1,
  clientVersion: "0.1.0",
};

let h: IngestHarness;

beforeAll(async () => {
  h = await startIngestHarness();
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.reset();
  await h.testDb.pool.query(
    "update integrations set last_seen_at = null, last_heartbeat = null, status = 'active'",
  );
  await h.testDb.pool.query("update api_keys set revoked_at = null");
});

function beat(key: string | undefined, body: unknown = heartbeat) {
  let req = request(h.app.getHttpServer()).post(HEARTBEAT_PATH);
  if (key) req = req.set("Authorization", `Bearer ${key}`);
  return req.send(body as object);
}

async function row(integrationId: string) {
  const res = await h.testDb.pool.query(
    "select last_seen_at, last_heartbeat from integrations where id = $1",
    [integrationId],
  );
  return res.rows[0] as { last_seen_at: Date | null; last_heartbeat: unknown };
}

describe("POST /v1/ingest/heartbeat", () => {
  it("stores the heartbeat and last_seen_at on the caller's integration only", async () => {
    const res = await beat(h.a.ingestKey);
    expect(res.status).toBe(204);
    const a = await row(h.a.integrationId);
    expect(a.last_heartbeat).toEqual(heartbeat);
    expect(a.last_seen_at?.toISOString()).toBe(FIXED_NOW);
    const b = await row(h.b.integrationId);
    expect(b.last_heartbeat).toBeNull();
    expect(b.last_seen_at).toBeNull();
  });

  it("ignores a userId/integrationId in the body (400, nothing written)", async () => {
    const res = await beat(h.a.ingestKey, { ...heartbeat, integrationId: h.b.integrationId });
    expect(res.status).toBe(400);
    expect(String(res.headers["content-type"])).toMatch(PROBLEM_JSON);
    expect(res.body).toMatchObject({ code: "request.invalid" });
    expect(JSON.stringify(res.body)).not.toContain(h.b.integrationId);
    expect((await row(h.a.integrationId)).last_heartbeat).toBeNull();
    expect((await row(h.b.integrationId)).last_heartbeat).toBeNull();
  });

  it.each([
    ["unknown key", { ...heartbeat, extra: 1 }],
    ["negative", { ...heartbeat, queueDepth: -1 }],
    ["missing field", { queueDepth: 1 }],
    ["control chars", { ...heartbeat, clientVersion: "1\n2" }],
  ])("rejects %s with 400 request.invalid", async (_l, body) => {
    const res = await beat(h.a.ingestKey, body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "request.invalid" });
    expect((await row(h.a.integrationId)).last_heartbeat).toBeNull();
  });

  it("rejects a missing key and another user's revoked key with 401", async () => {
    expect((await beat(undefined)).status).toBe(401);
    await h.testDb.pool.query("update api_keys set revoked_at = now() where id = $1", [
      h.a.ingestKeyId,
    ]);
    const res = await beat(h.a.ingestKey);
    expect(res.status).toBe(401);
    expect((await row(h.a.integrationId)).last_heartbeat).toBeNull();
    // The other user is unaffected.
    expect((await beat(h.b.ingestKey)).status).toBe(204);
  });

  it("bumps last_seen_at at most once per interval but always keeps the latest heartbeat", async () => {
    await beat(h.a.ingestKey);
    h.clock.set(new Date(Date.parse(FIXED_NOW) + LAST_SEEN_UPDATE_INTERVAL_MS - 1));
    await beat(h.a.ingestKey, { ...heartbeat, queueDepth: 9 });
    let a = await row(h.a.integrationId);
    expect(a.last_seen_at?.toISOString()).toBe(FIXED_NOW);
    expect(a.last_heartbeat).toMatchObject({ queueDepth: 9 });

    const later = new Date(Date.parse(FIXED_NOW) + LAST_SEEN_UPDATE_INTERVAL_MS);
    h.clock.set(later);
    await beat(h.a.ingestKey);
    a = await row(h.a.integrationId);
    expect(a.last_seen_at?.toISOString()).toBe(later.toISOString());
  });
});

describe("last_seen_at from ingest", () => {
  it("is bumped by a successful events request, throttled, and only for the caller", async () => {
    const res = await postEvents(h.app, h.a.ingestKey, [pageVisit()]);
    expect(res.status).toBe(200);
    expect((await row(h.a.integrationId)).last_seen_at?.toISOString()).toBe(FIXED_NOW);
    expect((await row(h.b.integrationId)).last_seen_at).toBeNull();

    h.clock.set(new Date(Date.parse(FIXED_NOW) + LAST_SEEN_UPDATE_INTERVAL_MS - 1));
    await postEvents(h.app, h.a.ingestKey, [pageVisit()]);
    expect((await row(h.a.integrationId)).last_seen_at?.toISOString()).toBe(FIXED_NOW);

    const later = new Date(Date.parse(FIXED_NOW) + LAST_SEEN_UPDATE_INTERVAL_MS);
    h.clock.set(later);
    await postEvents(h.app, h.a.ingestKey, [pageVisit()]);
    expect((await row(h.a.integrationId)).last_seen_at?.toISOString()).toBe(later.toISOString());
  });

  it("is not bumped by a request that fails as a whole", async () => {
    const res = await request(h.app.getHttpServer())
      .post("/v1/ingest/events")
      .set("Authorization", `Bearer ${h.a.ingestKey}`)
      .send({ events: [] });
    expect(res.status).toBe(400);
    expect((await row(h.a.integrationId)).last_seen_at).toBeNull();
  });
});
