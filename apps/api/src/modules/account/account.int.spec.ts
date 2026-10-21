/**
 * M6-04 account deletion against the real application (Testcontainers; CI runs these, Docker may
 * be off locally), with the two-user fixture and a fixed clock.
 *
 * "Done when" (PLAN §10): a completeness test that lists tables from the schema finds zero rows
 * left for the user. So the tables are DISCOVERED from the migrated database, never listed by
 * hand, and the test is not allowed to pass vacuously: before the deletion every discovered table
 * must hold rows for both users (a table nobody seeds fails the test and says so), and afterwards
 * the deleted user has none while the other user's rows are exactly as they were. Every foreign
 * key to `user` must also cascade, so a future `NO ACTION` key fails here and not in production.
 *
 * Also pinned: the password and confirmation gate, 401 for anything but a session, the old
 * credentials all dying, a failing cleanup step leaving everything in place, the per-account
 * throttle, and nothing secret reaching the logs.
 */

import { randomUUID } from "node:crypto";
import { ConsoleLogger, type INestApplication } from "@nestjs/common";
import { ACCOUNT_DELETE_CONFIRMATION } from "@personal-api/contracts";
import type { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { captureOutput, getMe, setCookieHeaders, signIn, signUp } from "../../../test/auth.helpers";
import { FakeClock } from "../../../test/fake-clock";
import { FORMER_READ_KEY } from "../../../test/former-read-key";
import { createExtension, issueCode } from "../../../test/pairing-helpers";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { buildFixtureApp, type FixtureUser, seedTwoUsers } from "../../../test/two-user-fixture";
import type { RateLimiter } from "../../platform/rate-limit/rate-limiter";
import { DeletionsRunService } from "../deletions/deletions-run.service";
import {
  ACCOUNT_DELETE_ATTEMPTS_PER_WINDOW,
  ACCOUNT_DELETE_WINDOW_MS,
  ACCOUNT_RATE_LIMITER,
} from "./account.constants";
import { AccountDeletionSteps } from "./account.steps";

const FIXED_NOW = "2026-10-14T12:00:00.000Z";
const PROBLEM_JSON = /^application\/problem\+json/;
const PATH = "/v1/account";

let testDb: TestDatabase;
let app: INestApplication;
const clock = new FakeClock(FIXED_NOW);
let a: FixtureUser;
let b: FixtureUser;

beforeAll(async () => {
  testDb = await startTestDatabase();
  app = await buildFixtureApp(testDb, { clock });
}, 240_000);

afterAll(async () => {
  await app?.close();
  await testDb?.stop();
});

/** Fresh users every test: the destructive ones delete the fixture users. */
beforeEach(async () => {
  clock.set(FIXED_NOW);
  ({ a, b } = await seedTwoUsers(app, testDb));
  app.get<RateLimiter>(ACCOUNT_RATE_LIMITER).reset();
  await seedActivity(a);
  await seedActivity(b);
});

const http = () => request(app.getHttpServer());
const body = (user: FixtureUser, extra: object = {}) => ({
  password: user.credentials.password,
  confirm: ACCOUNT_DELETE_CONFIRMATION,
  ...extra,
});
/** Passing `undefined` would pick the default, so "send nothing" has its own marker. */
const NO_BODY = Symbol("no body");
const deleteAccount = (user: FixtureUser, payload: unknown = body(user)) => {
  const req = http().delete(PATH).set("Cookie", user.cookie);
  return payload === NO_BODY ? req : req.send(payload as object);
};

function expectProblem(
  res: { status: number; headers: Record<string, unknown>; body: { code?: string } },
  status: number,
  code: string,
) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(String(res.headers["content-type"])).toMatch(PROBLEM_JSON);
  expect(res.body.code).toBe(code);
}

// --- seeding: a row in every table, for one user, through the real routes -------------------------

async function seedActivity(user: FixtureUser): Promise<void> {
  const post = (path: string, payload: unknown) =>
    http()
      .post(path)
      .set("Cookie", user.cookie)
      .send(payload as object);
  await testDb.pool.query("update integrations set default_policy = 'allow' where user_id = $1", [
    user.userId,
  ]);
  // integrations + pairing_codes (+ api_keys for the http integration)
  const extension = await createExtension(app, user, "completeness extension");
  await issueCode(app, user, extension);
  // events + ingestion_log
  const ingested = await request(app.getHttpServer())
    .post("/v1/ingest/events")
    .set("Authorization", `Bearer ${user.ingestKey}`)
    .send({
      events: [
        {
          id: randomUUID(),
          type: "browser.page_visited",
          typeVersion: 1,
          occurredAt: new Date(Date.parse(FIXED_NOW) - 60_000).toISOString(),
          data: {
            domain: "example.com",
            path: "/docs",
            transition: "link",
            tabRef: "tab-ref-12345678",
          },
        },
      ],
    });
  expect(ingested.status, JSON.stringify(ingested.body)).toBe(200);
  // rules + rule_sets + rule_history
  const rule = await post("/v1/rules", {
    name: "Track GitHub",
    enabled: true,
    priority: 10,
    stage: "collect",
    when: { all: [{ field: "data.domain", op: "eq", value: "github.com" }] },
    // biome-ignore lint/suspicious/noThenProperty: `then` is the rule format's own key.
    then: [{ action: "allow" }],
  });
  expect(rule.status, JSON.stringify(rule.body)).toBe(201);
  // retention_policies
  const policy = await http()
    .put("/v1/retention/type/browser.page_visited")
    .set("Cookie", user.cookie)
    .send({ days: 30 });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);
  // site_limits
  const limit = await post("/v1/limits", { pattern: "youtube.com", minutes: 30 });
  expect(limit.status, JSON.stringify(limit.body)).toBe(201);
  // bulk_deletions, and a queued job whose payload carries this user's id (no worker runs here)
  const bulk = await http()
    .delete("/v1/events")
    .set("Cookie", user.cookie)
    .send({ filter: { domain: "never-matches.example" } });
  expect(bulk.status, JSON.stringify(bulk.body)).toBe(202);
  // exports (+ a queued export job; its files are covered by exports.int.spec.ts)
  const exported = await post("/v1/exports", {});
  expect(exported.status, JSON.stringify(exported.body)).toBe(202);
  // verification rows are keyed by identifier/value, not by user_id (Better Auth's own shape)
  await testDb.pool.query(
    `insert into verification (id, identifier, value, expires_at) values
       ($1, $2, 'opaque', now() + interval '1 day'),
       ($3, $4, $5, now() + interval '1 day')`,
    [
      randomUUID(),
      user.credentials.email,
      randomUUID(),
      `reset-password:${randomUUID()}`,
      user.userId,
    ],
  );
}

// --- discovery: tables come from the database, never from a hand-written list ---------------------

/** Tables with no per-user key, each with the reason the deletion does not need to touch them. */
const EXEMPT_TABLES: Record<string, string> = {
  app_meta: "instance-level facts, no user data",
  verification:
    "Better Auth keys it by identifier (the email) or value, with no user_id; deleted explicitly and asserted below",
};

interface UserTable {
  table: string;
  column: string;
  onDelete: string;
}

/** Every table with a foreign key to `user`, plus `user` itself. */
async function discoverUserTables(pool: Pool): Promise<UserTable[]> {
  const fks = await pool.query<{ tbl: string; col: string; del: string }>(
    `select c.conrelid::regclass::text as tbl, a.attname as col, c.confdeltype::text as del
       from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.contype = 'f' and c.confrelid = '"user"'::regclass
      order by 1, 2`,
  );
  const found = fks.rows.map((row) => ({
    table: row.tbl.replaceAll('"', ""),
    column: row.col,
    onDelete: row.del,
  }));
  return [{ table: "user", column: "id", onDelete: "c" }, ...found];
}

async function publicTables(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
  );
  return rows.map((row) => row.table_name);
}

async function rowCounts(pool: Pool, userId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const { table, column } of await discoverUserTables(pool)) {
    // Identifiers come from the catalog above, the value is a bound parameter.
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from "${table}" where "${column}" = $1`,
      [userId],
    );
    counts[`${table}.${column}`] = rows[0]?.n ?? 0;
  }
  return counts;
}

/** Job rows that carry the user's id, over every pg-boss table that has a `data` column. */
async function jobRows(pool: Pool, userId: string): Promise<number> {
  const { rows: tables } = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.columns
      where table_schema = 'pgboss' and column_name = 'data' and data_type = 'jsonb'`,
  );
  expect(
    tables.map((t) => t.table_name),
    "pgboss.job must be among the job tables",
  ).toContain("job");
  let total = 0;
  for (const { table_name } of tables) {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from pgboss."${table_name}" where data ->> 'userId' = $1`,
      [userId],
    );
    total += rows[0]?.n ?? 0;
  }
  return total;
}

async function verificationRows(pool: Pool, user: FixtureUser): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "select count(*)::int as n from verification where identifier = $1 or value = $2",
    [user.credentials.email, user.userId],
  );
  return rows[0]?.n ?? 0;
}

async function userState(pool: Pool, user: FixtureUser) {
  return {
    counts: await rowCounts(pool, user.userId),
    jobs: await jobRows(pool, user.userId),
    verification: await verificationRows(pool, user),
  };
}

describe("the schema this test discovers", () => {
  it("has a foreign key to user on every public table except the exempt ones, and each cascades", async () => {
    const tables = await discoverUserTables(testDb.pool);
    const classified = new Set([...tables.map((t) => t.table), ...Object.keys(EXEMPT_TABLES)]);
    const unclassified = (await publicTables(testDb.pool)).filter((t) => !classified.has(t));
    expect(
      unclassified,
      "a table without a user foreign key must be listed in EXEMPT_TABLES with its reason, or be given one",
    ).toEqual([]);
    const notCascading = tables.filter((t) => t.onDelete !== "c").map((t) => t.table);
    expect(notCascading, "every key to user must be ON DELETE CASCADE").toEqual([]);
    expect(tables.length).toBeGreaterThan(10);
  });

  it("holds rows for both users in every discovered table before anything is deleted", async () => {
    for (const user of [a, b]) {
      const counts = await rowCounts(testDb.pool, user.userId);
      const empty = Object.entries(counts)
        .filter(([, n]) => n === 0)
        .map(([name]) => name);
      expect(empty, "seed a row in these tables, or the completeness test proves nothing").toEqual(
        [],
      );
      expect(await jobRows(testDb.pool, user.userId)).toBeGreaterThan(0);
      expect(await verificationRows(testDb.pool, user)).toBe(2);
    }
  });
});

describe("DELETE /v1/account", () => {
  it("removes every row of the user, from every table, and leaves the other user exactly as it was", async () => {
    const bBefore = await userState(testDb.pool, b);

    const res = await deleteAccount(a);

    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(res.text).toBe("");
    expect(String(res.headers["cache-control"])).toContain("no-store");
    const aAfter = await userState(testDb.pool, a);
    expect(
      Object.values(aAfter.counts).every((n) => n === 0),
      JSON.stringify(aAfter),
    ).toBe(true);
    expect(aAfter.jobs).toBe(0);
    expect(aAfter.verification).toBe(0);
    expect(await userState(testDb.pool, b)).toEqual(bBefore);
  });

  it("clears the session cookie in the response", async () => {
    const res = await deleteAccount(a);
    const cleared = setCookieHeaders(res).filter((line) => /session_token=/i.test(line));
    expect(cleared.length).toBeGreaterThan(0);
    for (const line of cleared) {
      expect(line).toMatch(/session_token=;/i);
      expect(line).toMatch(/max-age=0|expires=thu, 01 jan 1970/i);
    }
  });

  it("kills every credential of the account and lets the email be used again", async () => {
    const heartbeat = () =>
      http().post("/v1/ingest/heartbeat").set("Authorization", `Bearer ${a.ingestKey}`).send({});
    expect((await heartbeat()).status).not.toBe(401);

    expect((await deleteAccount(a)).status).toBe(204);

    expectProblem(await getMe(app, a.cookie), 401, "auth.unauthenticated");
    expectProblem(await heartbeat(), 401, "auth.invalid_key");
    const ingest = await http()
      .post("/v1/ingest/events")
      .set("Authorization", `Bearer ${a.ingestKey}`)
      .send({ events: [] });
    expect(ingest.status).toBe(401);
    expect((await signIn(app, a.credentials)).status).toBeGreaterThanOrEqual(400);
    // The account is gone, so the email is free again and the new account starts empty.
    const again = await signUp(app, a.credentials);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.user.id).not.toBe(a.userId);
    expect(
      Object.values(await rowCounts(testDb.pool, again.body.user.id)).filter((n) => n > 0),
    ).toHaveLength(3); // user, account, session: nothing of the old account came back
  });

  it("cannot be repeated: the session died with the account, so the second call is a 401", async () => {
    expect((await deleteAccount(a)).status).toBe(204);
    expectProblem(await deleteAccount(a), 401, "auth.unauthenticated");
  });

  it("deletes the session's account even when the request names someone else", async () => {
    const bBefore = await userState(testDb.pool, b);
    const res = await http()
      .delete(`${PATH}?userId=${b.userId}`)
      .set("Cookie", a.cookie)
      .set("X-User-Id", b.userId)
      .send(body(a));
    expect(res.status).toBe(204);
    expect((await rowCounts(testDb.pool, a.userId))["user.id"]).toBe(0);
    expect(await userState(testDb.pool, b)).toEqual(bBefore);
  });

  describe("proof that it is deliberate", () => {
    it("refuses a wrong password with 403 account.password_invalid and deletes nothing", async () => {
      const before = await userState(testDb.pool, a);
      const res = await deleteAccount(a, body(a, { password: "not-my-password" }));
      expectProblem(res, 403, "account.password_invalid");
      expect(setCookieHeaders(res)).toEqual([]);
      expect(await userState(testDb.pool, a)).toEqual(before);
      expect((await getMe(app, a.cookie)).status).toBe(200);
    });

    it("refuses another user's password", async () => {
      const res = await deleteAccount(a, body(a, { password: b.credentials.password }));
      expectProblem(res, 403, "account.password_invalid");
      expect((await rowCounts(testDb.pool, a.userId))["user.id"]).toBe(1);
    });

    it("refuses an account that has no password to check, the same way", async () => {
      await testDb.pool.query("delete from account where user_id = $1", [a.userId]);
      expectProblem(await deleteAccount(a), 403, "account.password_invalid");
      expect((await rowCounts(testDb.pool, a.userId))["user.id"]).toBe(1);
    });

    it.each([
      ["no body", NO_BODY],
      ["an empty body", {}],
      ["no confirmation", { password: "x" }],
      ["a wrong confirmation", { password: "x", confirm: "yes" }],
      ["no password", { confirm: ACCOUNT_DELETE_CONFIRMATION }],
      [
        "a user id in the body",
        { password: "x", confirm: ACCOUNT_DELETE_CONFIRMATION, userId: "u" },
      ],
    ])("answers 400 request.invalid for %s and deletes nothing", async (_label, payload) => {
      const before = await userState(testDb.pool, a);
      expectProblem(await deleteAccount(a, payload), 400, "request.invalid");
      expect(await userState(testDb.pool, a)).toEqual(before);
    });
  });

  describe("who may call it", () => {
    it("answers 401 to anything but a session, even with an invalid body, and deletes nothing", async () => {
      const before = await userState(testDb.pool, a);
      const bearers = [undefined, a.ingestKey, FORMER_READ_KEY];
      for (const bearer of bearers) {
        for (const payload of [body(a), { nonsense: true }]) {
          let req = http().delete(PATH);
          if (bearer) req = req.set("Authorization", `Bearer ${bearer}`);
          expectProblem(await req.send(payload), 401, "auth.unauthenticated");
        }
      }
      expect(await userState(testDb.pool, a)).toEqual(before);
    });
  });

  describe("throttle", () => {
    it("counts every attempt per account, answers 429 with Retry-After, and frees the account after the window", async () => {
      for (let i = 0; i < ACCOUNT_DELETE_ATTEMPTS_PER_WINDOW; i++) {
        expectProblem(
          await deleteAccount(a, body(a, { password: `wrong-${i}` })),
          403,
          "account.password_invalid",
        );
      }
      // Throttled: even the right password is not looked at.
      const blocked = await deleteAccount(a);
      expectProblem(blocked, 429, "account.rate_limited");
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      expect((await rowCounts(testDb.pool, a.userId))["user.id"]).toBe(1);
      // Another account has its own budget.
      expectProblem(
        await deleteAccount(b, body(b, { password: "wrong" })),
        403,
        "account.password_invalid",
      );

      clock.advance(ACCOUNT_DELETE_WINDOW_MS);
      expect((await deleteAccount(a)).status).toBe(204);
    });
  });

  describe("cleanup steps", () => {
    it("runs registered steps with the user id BEFORE any row is deleted", async () => {
      const seen: Array<{ userId: string; userRows: number }> = [];
      const unregister = app.get(AccountDeletionSteps).register({
        name: "probe",
        run: async (userId) => {
          const counts = await rowCounts(testDb.pool, userId);
          seen.push({
            userId,
            userRows: (counts["user.id"] ?? 0) + (counts["events.user_id"] ?? 0),
          });
        },
      });
      try {
        expect((await deleteAccount(a)).status).toBe(204);
      } finally {
        unregister();
      }
      expect(seen).toEqual([{ userId: a.userId, userRows: 2 }]);
    });

    it("leaves the account completely intact when a step throws, and works when repeated", async () => {
      const before = await userState(testDb.pool, a);
      const unregister = app.get(AccountDeletionSteps).register({
        name: "broken",
        run: async () => {
          throw new Error("disk is on fire");
        },
      });
      try {
        const res = await deleteAccount(a);
        expect(res.status).toBe(500);
        expect(String(res.headers["content-type"])).toMatch(PROBLEM_JSON);
        expect(JSON.stringify(res.body)).not.toContain("disk is on fire");
        expect(await userState(testDb.pool, a)).toEqual(before);
        expect((await getMe(app, a.cookie)).status).toBe(200);
      } finally {
        unregister();
      }
      expect((await deleteAccount(a)).status).toBe(204);
    });
  });

  describe("logs", () => {
    it("never carry the password or the email, on success or on a wrong password", async () => {
      // The testing module's logger prints errors only; this puts the service's own log lines on
      // the captured stream too, so the checks below can fail (the marker proves they are seen).
      app.useLogger(new ConsoleLogger());
      const capture = captureOutput();
      let output: string;
      try {
        await deleteAccount(a, body(a, { password: "wrong-secret-4f2a" }));
        await deleteAccount(a);
      } finally {
        output = capture.stop();
      }
      expect(output).toContain("account deleted");
      expect(output).toContain("request completed");
      expect(output).not.toContain("wrong-secret-4f2a");
      expect(output).not.toContain(a.credentials.password);
      expect(output).not.toContain(a.credentials.email);
      expect(output).not.toContain(a.cookie.slice(a.cookie.indexOf("=") + 1));
    });
  });
});

describe("a bulk-deletion job left queued for a deleted account", () => {
  it("finds nothing to do when its handler runs later", async () => {
    // The job rows are removed with the account; this guards the other order: a job a worker
    // already holds when the account goes away. The run service is a no-op for an unknown user.
    const { rows } = await testDb.pool.query<{ id: string }>(
      "select id from bulk_deletions where user_id = $1",
      [a.userId],
    );
    expect((await deleteAccount(a)).status).toBe(204);
    const runner = app.get(DeletionsRunService, { strict: false });
    expect(await runner.run(a.userId, (rows[0] as { id: string }).id)).toBe(0);
  });
});
