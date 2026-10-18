/**
 * M1-07 adversarial suite for the ingest routes (the cross-tenant sweep over every M1 route lives
 * in integrations/cross-tenant-sweep.int.spec.ts). Real application against Testcontainers (CI
 * runs these; Docker may be off locally), two-user fixture, fake clock.
 *
 *  - concurrency shapes beyond ingest.int.spec.ts: several keys of one integration, two users and
 *    two integrations sharing ids, overlapping windows in opposite id orders;
 *  - revocation mid-stream, through the M1-04 revoke route and through a single-key revoke;
 *  - an in-flight request that already passed the guard when the revoke commits (issue #29, item 1);
 *  - a captureOutput() sweep: ingest and heartbeat never log a domain, path, key or hash.
 */
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createViaRoute,
  type FreshIntegration,
  HEARTBEAT_PATH,
  heartbeatBody,
  postHeartbeat,
  revokeViaRoute,
  tenantState,
  waitForBlockedStatement,
} from "../../../test/adversarial-helpers";
import { captureOutput } from "../../../test/auth.helpers";
import {
  eventRows,
  expectResults,
  INGEST_PATH,
  type IngestHarness,
  type ItemResult,
  logRows,
  PROBLEM_JSON,
  pageVisit,
  post,
  postEvents,
  SENTINEL_DOMAIN,
  SENTINEL_PATH,
  setDefaultPolicy,
  startIngestHarness,
  tally,
} from "../../../test/ingest-helpers";
import type { FixtureUser } from "../../../test/two-user-fixture";
import { ApiKeysService } from "../keys/api-keys.service";
import { generateApiKey, hashApiKey } from "../keys/key-generation";

let h: IngestHarness;

/** A new integration of `user` through the route, set to allow so rules do not drop its events. */
async function createAllowing(user: FixtureUser, name: string) {
  const fresh = await createViaRoute(h.app, user, name);
  await setDefaultPolicy(h.testDb.pool, "allow", fresh.integrationId);
  return fresh;
}

beforeAll(async () => {
  h = await startIngestHarness();
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.reset();
});

const newIds = (n: number): string[] => Array.from({ length: n }, () => randomUUID());
const visits = (ids: readonly string[]) => ids.map((id) => pageVisit({ id }));

/** Sums the hourly rows of one (user[, integration]) into the counters a client could add up. */
async function logTotals(userId: string, integrationId?: string) {
  const rows = (await logRows(h.testDb.pool, userId)).filter(
    (row) => integrationId === undefined || row.integration_id === integrationId,
  );
  const reasons: Record<string, number> = {};
  for (const row of rows) {
    for (const [code, n] of Object.entries(row.by_reason)) reasons[code] = (reasons[code] ?? 0) + n;
  }
  return {
    accepted: rows.reduce((n, r) => n + r.accepted, 0),
    duplicate: rows.reduce((n, r) => n + r.duplicate, 0),
    dropped: rows.reduce((n, r) => n + r.dropped, 0),
    rejected: rows.reduce((n, r) => n + r.rejected, 0),
    reasons,
  };
}

/** The counters in the log equal what the clients were told, and the row count equals accepted. */
async function expectLogMatchesResults(
  userId: string,
  integrationId: string | undefined,
  results: ItemResult[],
) {
  const told = tally(results);
  expect(await logTotals(userId, integrationId)).toEqual({
    accepted: told.accepted,
    duplicate: told.duplicate,
    dropped: 0,
    rejected: told.rejected,
    reasons: told.reasons,
  });
  const rows = (await eventRows(h.testDb.pool, userId)).filter(
    (row) => integrationId === undefined || row.integration_id === integrationId,
  );
  expect(rows).toHaveLength(told.accepted);
}

/** Per id: exactly one `accepted` among the responses of one (user, integration). */
function expectOneAcceptedPerId(responses: ItemResult[][], ids: readonly string[]) {
  const all = responses.flat();
  for (const id of ids) {
    const forId = all.filter((r) => r.id === id);
    expect(forId.length, `id ${id} was sent`).toBeGreaterThan(0);
    expect(
      forId.filter((r) => r.status === "accepted"),
      `id ${id}`,
    ).toHaveLength(1);
    expect(forId.filter((r) => r.status === "duplicate")).toHaveLength(forId.length - 1);
  }
}

describe("concurrency: parallel posts of overlapping batches", () => {
  it("several keys of one integration racing on the same batch: one row and one accepted per id", async () => {
    const apiKeys = h.app.get(ApiKeysService);
    const second = await apiKeys.createIngestKey(h.a.userId, h.a.integrationId);
    const third = await apiKeys.createIngestKey(h.a.userId, h.a.integrationId);
    const keys = [h.a.ingestKey, second.key, third.key];
    const ids = newIds(12);
    const batch = [...visits(ids), { ...pageVisit(), type: "x.y" }];

    const responses = await Promise.all(
      Array.from({ length: 18 }, (_, i) =>
        postEvents(h.app, keys[i % keys.length] as string, batch),
      ),
    );
    const results = responses.map(expectResults);

    expectOneAcceptedPerId(results, ids);
    expect(await eventRows(h.testDb.pool)).toHaveLength(12);
    const flat = results.flat();
    expect(tally(flat)).toMatchObject({ accepted: 12, duplicate: 12 * 17, rejected: 18 });
    await expectLogMatchesResults(h.a.userId, h.a.integrationId, flat);
  });

  it("two users racing on the same ids each get their own accepted, and never see the other", async () => {
    const ids = newIds(10);
    const calls = Array.from({ length: 12 }, (_, i) =>
      postEvents(h.app, i % 2 === 0 ? h.a.ingestKey : h.b.ingestKey, visits(ids)),
    );
    const responses = await Promise.all(calls);
    const byUser = (even: boolean) =>
      responses.filter((_, i) => (i % 2 === 0) === even).map(expectResults);
    const forA = byUser(true);
    const forB = byUser(false);

    expectOneAcceptedPerId(forA, ids);
    expectOneAcceptedPerId(forB, ids);
    expect(await eventRows(h.testDb.pool, h.a.userId)).toHaveLength(10);
    expect(await eventRows(h.testDb.pool, h.b.userId)).toHaveLength(10);
    await expectLogMatchesResults(h.a.userId, h.a.integrationId, forA.flat());
    await expectLogMatchesResults(h.b.userId, h.b.integrationId, forB.flat());
  });

  it("two integrations of one user racing on the same ids dedupe per integration", async () => {
    const second = await createAllowing(h.a, "second source");
    const ids = newIds(8);
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        postEvents(h.app, i % 2 === 0 ? h.a.ingestKey : second.key, visits(ids)),
      ),
    );
    const results = responses.map(expectResults);
    const first = results.filter((_, i) => i % 2 === 0);
    const other = results.filter((_, i) => i % 2 === 1);

    expectOneAcceptedPerId(first, ids);
    expectOneAcceptedPerId(other, ids);
    expect(await eventRows(h.testDb.pool, h.a.userId)).toHaveLength(16);
    await expectLogMatchesResults(h.a.userId, h.a.integrationId, first.flat());
    await expectLogMatchesResults(h.a.userId, second.integrationId, other.flat());
  });

  it("overlapping windows sent in opposite id orders never deadlock and stay exact", async () => {
    const pool = newIds(40);
    const sent = new Set<string>();
    const requests = Array.from({ length: 16 }, (_, i) => {
      const window = Array.from(
        { length: 20 },
        (_, j) => pool[(i * 5 + j) % pool.length] as string,
      );
      for (const id of window) sent.add(id);
      // Opposite orders: a sort-less insert would lock rows in opposite orders and deadlock.
      const ordered = i % 2 === 0 ? window : [...window].reverse();
      return postEvents(h.app, h.a.ingestKey, visits(ordered));
    });
    const responses = await Promise.all(requests);
    for (const res of responses) expect(res.status, JSON.stringify(res.body)).toBe(200);
    const results = responses.map(expectResults);

    expectOneAcceptedPerId(results, [...sent]);
    expect(await eventRows(h.testDb.pool)).toHaveLength(sent.size);
    await expectLogMatchesResults(h.a.userId, h.a.integrationId, results.flat());
  });
});

describe("revocation takes effect on the next request", () => {
  async function expectRefused(fresh: FreshIntegration) {
    const events = await postEvents(h.app, fresh.key, [pageVisit()]);
    const beat = await postHeartbeat(h.app, fresh.key, heartbeatBody);
    for (const res of [events, beat]) {
      expect(res.status).toBe(401);
      expect(String(res.headers["content-type"])).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe("auth.invalid_key");
    }
    const unknown = await postEvents(h.app, generateApiKey("ingest").plaintext, [pageVisit()]);
    expect(events.body).toEqual(unknown.body);
  }

  it("revoking the integration through the route: events and heartbeat are 401 at once, nothing changes", async () => {
    const fresh = await createAllowing(h.a, "to revoke");
    expectResults(await postEvents(h.app, fresh.key, [pageVisit()]));
    expect((await postHeartbeat(h.app, fresh.key, heartbeatBody)).status).toBe(204);

    const revoked = await revokeViaRoute(h.app, h.a, fresh.integrationId);
    expect(revoked.status).toBe(200);
    const before = await tenantState(h.testDb.pool, h.a.userId);

    await expectRefused(fresh);
    expect(await tenantState(h.testDb.pool, h.a.userId)).toEqual(before);
    // The other integration of the same user, and the other user, are untouched.
    expectResults(await postEvents(h.app, h.a.ingestKey, [pageVisit()]));
    expectResults(await postEvents(h.app, h.b.ingestKey, [pageVisit()]));
  });

  it("revoking one key leaves the integration's other key working", async () => {
    const fresh = await createAllowing(h.a, "two keys");
    const other = await h.app.get(ApiKeysService).createIngestKey(h.a.userId, fresh.integrationId);

    expect(await h.app.get(ApiKeysService).revokeKey(h.a.userId, fresh.keyId)).toBe(true);
    await expectRefused(fresh);
    expectResults(await postEvents(h.app, other.key, [pageVisit()]));
    expect((await postHeartbeat(h.app, other.key, heartbeatBody)).status).toBe(204);
  });

  it("a revoke racing four concurrent streams: 200s then 401s per stream, 401 for anything started after it returned, no 500", async () => {
    const fresh = await createAllowing(h.a, "stream");
    let seq = 0;
    let revokeReturnedSeq = Number.POSITIVE_INFINITY;
    let firstSuccess: () => void = () => undefined;
    const sawSuccess = new Promise<void>((resolve) => {
      firstSuccess = resolve;
    });
    interface Seen {
      worker: number;
      startSeq: number;
      status: number;
      id: string;
    }
    const seen: Seen[] = [];

    const worker = async (n: number) => {
      for (let i = 0; i < 300; i += 1) {
        const id = randomUUID();
        const startSeq = ++seq;
        const res = await postEvents(h.app, fresh.key, visits([id]));
        seen.push({ worker: n, startSeq, status: res.status, id });
        if (res.status === 200) firstSuccess();
        if (res.status === 401) return;
      }
    };
    const revoker = async () => {
      await sawSuccess;
      await new Promise((resolve) => setTimeout(resolve, 15));
      const res = await revokeViaRoute(h.app, h.a, fresh.integrationId);
      revokeReturnedSeq = ++seq;
      expect(res.status).toBe(200);
    };
    await Promise.all([revoker(), ...[0, 1, 2, 3].map(worker)]);

    expect(seen.every((s) => s.status === 200 || s.status === 401)).toBe(true);
    expect(seen.some((s) => s.status === 200)).toBe(true);
    expect(seen.some((s) => s.status === 401)).toBe(true);
    for (const n of [0, 1, 2, 3]) {
      const statuses = seen.filter((s) => s.worker === n).map((s) => s.status);
      expect(statuses.lastIndexOf(200), `worker ${n}`).toBeLessThan(
        statuses.indexOf(401) === -1 ? statuses.length : statuses.indexOf(401),
      );
    }
    for (const s of seen.filter((x) => x.startSeq > revokeReturnedSeq)) expect(s.status).toBe(401);

    // Stored rows are exactly the events that were answered 200 (no 401 stored anything).
    const stored = (await eventRows(h.testDb.pool, h.a.userId))
      .filter((row) => row.integration_id === fresh.integrationId)
      .map((row) => row.client_event_id)
      .sort();
    expect(stored).toEqual(
      seen
        .filter((s) => s.status === 200)
        .map((s) => s.id)
        .sort(),
    );
    const log = await logTotals(h.a.userId, fresh.integrationId);
    expect(log).toMatchObject({ accepted: stored.length, duplicate: 0, rejected: 0 });

    // Once revoke has returned, nothing gets in any more.
    const after = await tenantState(h.testDb.pool, h.a.userId);
    expect((await postEvents(h.app, fresh.key, [pageVisit()])).status).toBe(401);
    expect((await postHeartbeat(h.app, fresh.key, heartbeatBody)).status).toBe(401);
    expect(await tenantState(h.testDb.pool, h.a.userId)).toEqual(after);
  });
});

describe("a request already past the guard when the revoke commits (issue #29, item 1)", () => {
  // The client holds an uncommitted revoke, the request passes the guard (it still sees the key as
  // live) and reaches the ingest transaction, whose first statement must wait for the revoke and
  // then refuse. Afterwards: 401 auth.invalid_key, no event, no counter.
  async function expectInFlightRefused(
    fresh: FreshIntegration,
    holdRevoke: (sql: (text: string, values?: unknown[]) => Promise<unknown>) => Promise<void>,
  ) {
    // Prime last_used_at so the guard's throttled touch skips the key row the client holds.
    expectResults(await postEvents(h.app, fresh.key, [pageVisit()]));
    await h.reset();
    const client = await h.testDb.pool.connect();
    try {
      await client.query("begin");
      await holdRevoke((text, values) => client.query(text, values));

      const state = await tenantState(h.testDb.pool, h.a.userId);
      let settled = false;
      const inFlight = postEvents(h.app, fresh.key, [pageVisit()]).then((res) => {
        settled = true;
        return res;
      });
      await waitForBlockedStatement(h.testDb.pool, "for share");
      expect(settled).toBe(false);
      await client.query("commit");

      const res = await inFlight;
      expect(res.status).toBe(401);
      expect(String(res.headers["content-type"])).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe("auth.invalid_key");
      const unknown = await postEvents(h.app, generateApiKey("ingest").plaintext, [pageVisit()]);
      expect(res.body).toEqual(unknown.body);

      expect(await eventRows(h.testDb.pool, h.a.userId)).toEqual([]);
      expect(await logRows(h.testDb.pool, h.a.userId)).toEqual([]);
      const after = await tenantState(h.testDb.pool, h.a.userId);
      expect(after.events).toEqual(state.events);
      expect(after.ingestionLog).toEqual(state.ingestionLog);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  }

  it("stores nothing when the integration is revoked while the request waits", async () => {
    const fresh = await createAllowing(h.a, "in flight: integration");
    await expectInFlightRefused(fresh, async (sql) => {
      await sql("update integrations set status = 'revoked' where id = $1", [fresh.integrationId]);
      await sql("update api_keys set revoked_at = now() where integration_id = $1", [
        fresh.integrationId,
      ]);
    });
  });

  it("stores nothing when only the key is revoked while the request waits", async () => {
    const fresh = await createAllowing(h.a, "in flight: key");
    await expectInFlightRefused(fresh, async (sql) => {
      await sql("update api_keys set revoked_at = now() where id = $1", [fresh.keyId]);
    });
  });
});

describe("log hygiene sweep (invariant 6): ingest and heartbeat", () => {
  const sensitive = (keys: string[]): string[] => [
    SENTINEL_DOMAIN,
    SENTINEL_PATH,
    "sentinel-path-7c1e",
    "sentinel-query-7c1e",
    ...keys,
    ...keys.map((key) => key.slice("pa_ing_".length)),
    ...keys.map(hashApiKey),
  ];
  const PADDING = "x".repeat(300 * 1024);

  it("writes no domain, path, key or hash to the process output on any ingest or heartbeat outcome", async () => {
    const revoked = await createAllowing(h.a, "log hygiene");
    expect((await revokeViaRoute(h.app, h.a, revoked.integrationId)).status).toBe(200);
    const unknown = generateApiKey("ingest").plaintext;
    const read = generateApiKey("read").plaintext;
    const sentinelEvent = () =>
      pageVisit({ data: { domain: SENTINEL_DOMAIN, path: SENTINEL_PATH } });
    const query = "?domain=sentinel-query-7c1e&path=/sentinel-path-7c1e";
    const authed = (key: string, path: string) =>
      request(h.app.getHttpServer()).post(path).set("Authorization", `Bearer ${key}`);

    const capture = captureOutput();
    let output = "";
    const statuses: number[] = [];
    try {
      const seen = async (res: Promise<{ status: number }>) =>
        void statuses.push((await res).status);
      // events: accepted, duplicate, rejected, whole-request invalid, query string
      const event = sentinelEvent();
      await seen(
        postEvents(h.app, h.a.ingestKey, [event, event, { ...sentinelEvent(), type: "x.y" }]),
      );
      await seen(post(h.app, h.a.ingestKey, { events: [event], [SENTINEL_DOMAIN]: SENTINEL_PATH }));
      await seen(
        authed(h.a.ingestKey, `${INGEST_PATH}${query}`).send({ events: [sentinelEvent()] }),
      );
      // heartbeat: valid (sentinel as a version string), invalid, query string
      await seen(
        postHeartbeat(h.app, h.a.ingestKey, { ...heartbeatBody, clientVersion: SENTINEL_PATH }),
      );
      await seen(
        postHeartbeat(h.app, h.a.ingestKey, { ...heartbeatBody, [SENTINEL_DOMAIN]: SENTINEL_PATH }),
      );
      await seen(authed(h.a.ingestKey, `${HEARTBEAT_PATH}${query}`).send(heartbeatBody));
      // keys: revoked, unknown, wrong kind, malformed
      for (const key of [revoked.key, unknown, read, `pa_ing_${SENTINEL_DOMAIN}`]) {
        await seen(postEvents(h.app, key, [sentinelEvent()]));
        await seen(postHeartbeat(h.app, key, { ...heartbeatBody, clientVersion: SENTINEL_PATH }));
      }
      // body parser failures: malformed, truncated and oversized JSON that contain the sentinels
      const malformed = `{"events":[{"data":{"domain":"${SENTINEL_DOMAIN}","path":"${SENTINEL_PATH}"`;
      for (const path of [INGEST_PATH, HEARTBEAT_PATH]) {
        await seen(
          authed(h.a.ingestKey, path).set("Content-Type", "application/json").send(malformed),
        );
        await seen(
          authed(h.a.ingestKey, path)
            .set("Content-Type", "application/json")
            .send(`{"${SENTINEL_DOMAIN}":"${SENTINEL_PATH}","pad":"${PADDING}${PADDING}"}`),
        );
      }
    } finally {
      output = capture.stop();
    }

    // The requests really reached the routes and the failure paths, so the checks below mean something.
    expect(statuses.slice(0, 6)).toEqual([200, 400, 200, 204, 400, 204]);
    expect(statuses.slice(6, 14).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(14)).toEqual([400, 413, 400, 413]);
    // ... and logging is observable at all (otherwise a silent logger would pass every check).
    expect(output, "captured output should include the request log lines").toContain("statusCode");
    for (const secret of sensitive([h.a.ingestKey, revoked.key, unknown, read])) {
      expect(output, `leaked: ${secret.slice(0, 12)}`).not.toContain(secret);
    }
  });
});
