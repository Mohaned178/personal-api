/**
 * M1-07 helpers shared by the adversarial specs: a fresh integration per test (so revoking never
 * poisons the two-user fixture), a tenant state snapshot to compare before and after an attack,
 * the heartbeat route and a lock-wait probe. HTTP, SQL and exported contracts only.
 */
import type { INestApplication } from "@nestjs/common";
import { createIntegrationResponseSchema } from "@personal-api/contracts";
import type { Pool } from "pg";
import request from "supertest";
import { expect } from "vitest";
import type { FixtureUser } from "./two-user-fixture";

export const HEARTBEAT_PATH = "/v1/ingest/heartbeat";

export const heartbeatBody = {
  queueDepth: 4,
  oldestQueuedAgeMs: 2500,
  droppedCount: 1,
  clientVersion: "0.1.0",
};

export interface FreshIntegration {
  integrationId: string;
  keyId: string;
  key: string;
}

/** Creates an integration through the real route as `user`. */
export async function createViaRoute(
  app: INestApplication,
  user: FixtureUser,
  name: string,
): Promise<FreshIntegration> {
  const res = await request(app.getHttpServer())
    .post("/v1/integrations")
    .set("Cookie", user.cookie)
    .send({ kind: "http", name });
  expect(res.status).toBe(201);
  const created = createIntegrationResponseSchema.parse(res.body);
  return {
    integrationId: created.integration.id,
    keyId: created.ingestKey.id,
    key: created.ingestKey.key,
  };
}

/** The M1-04 revoke route (the only way to revoke over HTTP). */
export function revokeViaRoute(app: INestApplication, user: FixtureUser, integrationId: string) {
  return request(app.getHttpServer())
    .post(`/v1/integrations/${integrationId}/revoke`)
    .set("Cookie", user.cookie);
}

export function postHeartbeat(app: INestApplication, key: string | undefined, body: unknown) {
  let req = request(app.getHttpServer()).post(HEARTBEAT_PATH);
  if (key) req = req.set("Authorization", `Bearer ${key}`);
  return req.send(body as object);
}

/**
 * Everything the M1 routes can touch for one user, as plain JSON: deep-equal before and after
 * means the call changed nothing of theirs. Key hashes stay in (they never change) so a swapped
 * key would show.
 */
export async function tenantState(pool: Pool, userId: string): Promise<Record<string, unknown[]>> {
  const q = async (sql: string): Promise<unknown[]> =>
    (await pool.query(sql, [userId])).rows as unknown[];
  return {
    integrations: await q("select * from integrations where user_id = $1 order by id"),
    apiKeys: await q("select * from api_keys where user_id = $1 order by id"),
    events: await q("select * from events where user_id = $1 order by client_event_id"),
    ingestionLog: await q("select * from ingestion_log where user_id = $1 order by bucket"),
    pairingCodes: await q("select * from pairing_codes where user_id = $1 order by id"),
  };
}

/**
 * Waits until some other backend is blocked on a lock while running a statement that contains
 * `queryFragment` (lower case). Filtering on the statement keeps an unrelated waiter, such as
 * a throttled UPDATE, from satisfying the wait. Throws after ~5 s.
 */
export async function waitForBlockedStatement(pool: Pool, queryFragment: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from pg_stat_activity
       where wait_event_type = 'Lock' and pid <> pg_backend_pid() and lower(query) like $1`,
      [`%${queryFragment}%`],
    );
    if (Number(rows[0]?.n) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no backend ever waited on a lock in a statement containing "${queryFragment}"`);
}
