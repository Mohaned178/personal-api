/**
 * M6-R: events stored before M6-01 have `expires_at = NULL`, which the purge's `expires_at <= now`
 * never matches, so they would be kept forever. The `backfill_event_expiry` data migration gives
 * them the 90-day default. Real Postgres (Testcontainers; CI runs these, Docker may be off locally).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RETENTION_DEFAULT_DAYS } from "@personal-api/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DAY_MS,
  FIXED_NOW,
  type IngestHarness,
  startIngestHarness,
} from "../../../test/ingest-helpers";
import { MIGRATIONS_FOLDER } from "../../../test/postgres";
import { RetentionPurgeService } from "./retention-purge.service";

let h: IngestHarness;
let purge: RetentionPurgeService;

beforeAll(async () => {
  h = await startIngestHarness();
  purge = h.app.get(RetentionPurgeService);
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.reset();
});

const NOW = Date.parse(FIXED_NOW);
const daysAgo = (days: number) => new Date(NOW - days * DAY_MS);

/** The migration's SQL as written in the file, so the test fails if the file stays empty. */
function backfillSql(): string {
  return readFileSync(path.join(MIGRATIONS_FOLDER, "0012_backfill_event_expiry.sql"), "utf8");
}

async function insertEvent(
  userId: string,
  integrationId: string,
  receivedAt: Date,
  expiresAt: Date | null,
): Promise<string> {
  const { rows } = await h.testDb.pool.query<{ id: string }>(
    `insert into events (user_id, integration_id, client_event_id, type, type_version, occurred_at, received_at, expires_at, data)
     values ($1, $2, $3, 'browser.page_visited', 1, $4, $4, $5, '{"domain":"example.com","path":"/"}'::jsonb) returning id`,
    [userId, integrationId, randomUUID(), receivedAt, expiresAt],
  );
  return (rows[0] as { id: string }).id;
}

const expiryOf = async (id: string) =>
  (
    await h.testDb.pool.query<{ expires_at: Date | null }>(
      "select expires_at from events where id = $1",
      [id],
    )
  ).rows[0]?.expires_at ?? null;

describe("backfill_event_expiry migration", () => {
  it("gives events without an expiry received_at + 90 days, for every user, and leaves set values alone", async () => {
    const { a, b } = h;
    const oldA = await insertEvent(a.userId, a.integrationId, daysAgo(100), null);
    const freshA = await insertEvent(a.userId, a.integrationId, daysAgo(10), null);
    const oldB = await insertEvent(b.userId, b.integrationId, daysAgo(120), null);
    const keptByRule = daysAgo(-300);
    const ruled = await insertEvent(a.userId, a.integrationId, daysAgo(100), keptByRule);

    await h.testDb.pool.query(backfillSql());

    expect((await expiryOf(oldA))?.getTime()).toBe(daysAgo(100).getTime() + 90 * DAY_MS);
    expect((await expiryOf(freshA))?.getTime()).toBe(daysAgo(10).getTime() + 90 * DAY_MS);
    expect((await expiryOf(oldB))?.getTime()).toBe(daysAgo(120).getTime() + 90 * DAY_MS);
    expect((await expiryOf(ruled))?.getTime()).toBe(keptByRule.getTime());
    expect(RETENTION_DEFAULT_DAYS).toBe(90);

    // Running it again changes nothing, so a re-applied migration is safe.
    await h.testDb.pool.query(backfillSql());
    expect((await expiryOf(oldA))?.getTime()).toBe(daysAgo(100).getTime() + 90 * DAY_MS);
  });

  it("makes a pre-retention event past its 90 days purgeable, and keeps a younger one", async () => {
    const { a } = h;
    const old = await insertEvent(a.userId, a.integrationId, daysAgo(100), null);
    const fresh = await insertEvent(a.userId, a.integrationId, daysAgo(10), null);

    // Before the migration the purge cannot see the old event: this is the bug.
    expect(await purge.run()).toBe(0);
    expect(await expiryOf(old)).toBeNull();

    await h.testDb.pool.query(backfillSql());

    expect(await purge.run()).toBe(1);
    const left = await h.testDb.pool.query<{ id: string }>(
      "select id from events where user_id = $1",
      [a.userId],
    );
    expect(left.rows.map((r) => r.id)).toEqual([fresh]);
  });
});
