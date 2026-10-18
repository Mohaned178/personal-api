/**
 * M1-05 test helpers for `POST /v1/ingest/events`. Everything here goes through the public
 * surface only: HTTP, the database tables and the exported contracts.
 *
 * Assumptions (also listed in the test-writer report):
 *  - The route answers 200 (not 201) with `{ results: [...] }`, also when every item is rejected.
 *  - The server reads "now" from the injected `CLOCK` (the fixture overrides it with a FakeClock).
 *  - Whole-request failures use `code` in the problem body; per-item failures use `results[i].code`.
 */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { ingestBatchResponseSchema } from "@personal-api/contracts";
import type { Pool } from "pg";
import request from "supertest";
import { expect } from "vitest";
import { PAIRING_RATE_LIMITER } from "../src/modules/pairing/pairing.tokens";
import { RuleSetProvider } from "../src/modules/rules/rule-set.provider";
import type { RateLimiter } from "../src/platform/rate-limit/rate-limiter";
import { FakeClock } from "./fake-clock";
import { startTestDatabase, type TestDatabase } from "./postgres";
import { buildFixtureApp, type FixtureUser, seedTwoUsers } from "./two-user-fixture";

export const INGEST_PATH = "/v1/ingest/events";
export const PROBLEM_JSON = /^application\/problem\+json/;
export const FIXED_NOW = "2026-10-14T12:00:00.000Z";
export const DAY_MS = 86_400_000;
/** The fixed retention-like window of M1-05 (until M6): older events are rejected. */
export const MAX_AGE_MS = 90 * DAY_MS;
/** Events further than this ahead of the server clock are clamped. */
export const FUTURE_SKEW_MS = 5 * 60 * 1000;
/** Body limit of the ingest route. */
export const INGEST_LIMIT_BYTES = 256 * 1024;
/** Body limit of every other route. */
export const DEFAULT_LIMIT_BYTES = 100 * 1024;

export const SENTINEL_DOMAIN = "sentinel-domain-7c1e.example";
export const SENTINEL_PATH = "/sentinel-path-7c1e/segment";

export type ItemResult = { id?: string; status: string; code?: string };
export type Json = Record<string, unknown>;

export function isoAt(base: string | Date, offsetMs: number): string {
  return new Date(new Date(base).getTime() + offsetMs).toISOString();
}

/** A valid `browser.page_visited` v1 event. `extra` is merged last, so it can break the envelope. */
export function pageVisit(
  options: { id?: string; occurredAt?: string; data?: Json; extra?: Json } = {},
): Json {
  return {
    id: options.id ?? randomUUID(),
    type: "browser.page_visited",
    typeVersion: 1,
    occurredAt: options.occurredAt ?? isoAt(FIXED_NOW, -60_000),
    data: {
      domain: "example.com",
      path: "/docs/intro",
      transition: "link",
      tabRef: "tab-ref-12345678",
      ...options.data,
    },
    meta: { ruleSetVersion: 1, client: "pa-test/0.0.0" },
    ...options.extra,
  };
}

/** A valid `browser.focus_segment` v1 event (5 minutes, durationMs consistent with the bounds). */
export function focusSegment(options: { id?: string; occurredAt?: string } = {}): Json {
  return {
    id: options.id ?? randomUUID(),
    type: "browser.focus_segment",
    typeVersion: 1,
    occurredAt: options.occurredAt ?? isoAt(FIXED_NOW, -60_000),
    data: {
      domain: "example.com",
      path: "/docs/intro",
      startedAt: "2026-10-14T11:50:00.000Z",
      endedAt: "2026-10-14T11:55:00.000Z",
      durationMs: 300_000,
    },
  };
}

type Agent = ReturnType<typeof request>;
const agent = (app: INestApplication): Agent => request(app.getHttpServer());

/** POST a JSON body (string = sent verbatim) with an optional ingest key. */
export function post(app: INestApplication, key: string | undefined, body?: unknown) {
  let req = agent(app).post(INGEST_PATH);
  if (key) req = req.set("Authorization", `Bearer ${key}`);
  if (typeof body === "string") return req.set("Content-Type", "application/json").send(body);
  return body === undefined ? req : req.send(body as object);
}

export function postEvents(app: INestApplication, key: string, events: unknown[]) {
  return post(app, key, { events });
}

/** Asserts a 200 JSON batch response that matches the strict contract; returns the results. */
export function expectResults(res: {
  status: number;
  headers: Record<string, unknown>;
  body: unknown;
}): ItemResult[] {
  expect(res.status).toBe(200);
  expect(String(res.headers["content-type"])).toMatch(/^application\/json/);
  const parsed = ingestBatchResponseSchema.safeParse(res.body);
  expect(parsed.success, "response must match ingestBatchResponseSchema (strict)").toBe(true);
  const results = (res.body as { results: ItemResult[] }).results;
  return results;
}

/** Strips ids so a result list can be compared on status and code only. */
export const statuses = (results: ItemResult[]): string[] => results.map((r) => r.status);

export interface EventRow {
  id: string;
  user_id: string;
  integration_id: string;
  client_event_id: string;
  type: string;
  type_version: number;
  occurred_at: Date;
  client_occurred_at: Date | null;
  received_at: Date;
  origin: string;
  data: Json;
  tags: string[];
  trace: unknown;
  expires_at: Date | null;
}

export async function eventRows(pool: Pool, userId?: string): Promise<EventRow[]> {
  const { rows } =
    userId === undefined
      ? await pool.query<EventRow>("select * from events order by client_event_id")
      : await pool.query<EventRow>(
          "select * from events where user_id = $1 order by client_event_id",
          [userId],
        );
  return rows;
}

export interface LogRow {
  user_id: string;
  integration_id: string;
  bucket: Date;
  accepted: number;
  duplicate: number;
  dropped: number;
  rejected: number;
  by_reason: Record<string, number>;
}

export async function logRows(pool: Pool, userId?: string): Promise<LogRow[]> {
  const { rows } =
    userId === undefined
      ? await pool.query<LogRow>("select * from ingestion_log order by bucket")
      : await pool.query<LogRow>("select * from ingestion_log where user_id = $1 order by bucket", [
          userId,
        ]);
  return rows;
}

/** Counters as the client sees them in the results of one or more responses. */
export function tally(results: ItemResult[]) {
  const reasons: Record<string, number> = {};
  let accepted = 0;
  let duplicate = 0;
  let rejected = 0;
  for (const r of results) {
    if (r.status === "accepted") accepted++;
    else if (r.status === "duplicate") duplicate++;
    else if (r.status === "rejected") {
      rejected++;
      if (r.code) reasons[r.code] = (reasons[r.code] ?? 0) + 1;
    }
  }
  return { accepted, duplicate, rejected, reasons };
}

export interface IngestHarness {
  testDb: TestDatabase;
  app: INestApplication;
  clock: FakeClock;
  a: FixtureUser;
  b: FixtureUser;
  /** Empties events, ingestion_log, pairing codes and rules, and puts the clock back to FIXED_NOW. Users stay. */
  reset: () => Promise<void>;
  stop: () => Promise<void>;
}

/** Sets `default_policy` on every integration, or on the one given. */
export async function setDefaultPolicy(
  pool: Pool,
  policy: "allow" | "deny",
  integrationId?: string,
): Promise<void> {
  if (integrationId === undefined) {
    await pool.query("update integrations set default_policy = $1", [policy]);
  } else {
    await pool.query("update integrations set default_policy = $1 where id = $2", [
      policy,
      integrationId,
    ]);
  }
}

/** Real app + fresh Postgres + the two-user fixture, with a controllable clock. */
export async function startIngestHarness(): Promise<IngestHarness> {
  const testDb = await startTestDatabase();
  const clock = new FakeClock(FIXED_NOW);
  const app = await buildFixtureApp(testDb, { clock });
  const { a, b } = await seedTwoUsers(app, testDb);
  // The fixture's integrations deny by default (M4-05 enforces rules), so with no rules every
  // event would be dropped. These tests are about ingestion itself: let events through unless a
  // test sets a policy or adds rules (`setDefaultPolicy`).
  await setDefaultPolicy(testDb.pool, "allow");
  return {
    testDb,
    app,
    clock,
    a,
    b,
    reset: async () => {
      await testDb.pool.query(
        "truncate events, ingestion_log, pairing_codes, rules, rule_sets, rule_history restart identity",
      );
      clock.set(FIXED_NOW);
      // The truncate restarts every rule-set version at 0, so cached sets would look current.
      app.get(RuleSetProvider).clear();
      // Every request in a test run comes from one address, so forget the pairing throttle.
      app.get<RateLimiter>(PAIRING_RATE_LIMITER).reset();
    },
    stop: async () => {
      await app.close();
      await testDb.stop();
    },
  };
}
