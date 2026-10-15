/**
 * M2-01 helpers for the pairing routes. HTTP, SQL and exported contracts only.
 */
import type { INestApplication } from "@nestjs/common";
import { integrationResponseSchema, pairingCodeResponseSchema } from "@personal-api/contracts";
import type { Pool } from "pg";
import request from "supertest";
import { expect } from "vitest";
import type { FixtureUser } from "./two-user-fixture";

export const PAIR_PATH = "/v1/pair";
export const pairingCodePath = (integrationId: string) =>
  `/v1/integrations/${integrationId}/pairing-code`;

const http = (app: INestApplication) => request(app.getHttpServer());

/** Creates a `browser-extension` integration through the real route as `user`. */
export async function createExtension(
  app: INestApplication,
  user: FixtureUser,
  name = "Work Edge",
): Promise<string> {
  const res = await http(app)
    .post("/v1/integrations")
    .set("Cookie", user.cookie)
    .send({ kind: "browser-extension", name });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return integrationResponseSchema.parse(res.body).integration.id;
}

export function requestCode(app: INestApplication, user: FixtureUser, integrationId: string) {
  return http(app).post(pairingCodePath(integrationId)).set("Cookie", user.cookie);
}

/** Issues a code through the real route; returns the plaintext as the dashboard would show it. */
export async function issueCode(
  app: INestApplication,
  user: FixtureUser,
  integrationId: string,
): Promise<{ pairingCode: string; expiresAt: string }> {
  const res = await requestCode(app, user, integrationId);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return pairingCodeResponseSchema.parse(res.body);
}

export function pair(app: INestApplication, body: unknown) {
  return http(app)
    .post(PAIR_PATH)
    .send(body as object);
}

export interface PairingRow {
  id: string;
  user_id: string;
  integration_id: string;
  code_hash: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

export async function pairingRows(pool: Pool, integrationId?: string): Promise<PairingRow[]> {
  const { rows } =
    integrationId === undefined
      ? await pool.query<PairingRow>("select * from pairing_codes order by created_at, id")
      : await pool.query<PairingRow>(
          "select * from pairing_codes where integration_id = $1 order by created_at, id",
          [integrationId],
        );
  return rows;
}

export async function keyCount(pool: Pool, integrationId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "select count(*)::text as n from api_keys where integration_id = $1",
    [integrationId],
  );
  return Number(rows[0]?.n);
}
