import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetAuthTables } from "../../../test/auth.helpers";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { SignupGate } from "./signup-gate";

let testDb: TestDatabase;
const pools: Pool[] = [];

beforeAll(async () => {
  testDb = await startTestDatabase();
}, 180_000);

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await testDb?.stop();
});

beforeEach(async () => {
  await resetAuthTables(testDb.pool);
});

/** One gate per "process": its own pool and its own in-process queue. */
function processGate(): SignupGate {
  const pool = new Pool({ connectionString: testDb.url });
  pools.push(pool);
  return new SignupGate({ ALLOW_SIGNUP: false }, pool);
}

/** Stands in for Better Auth's sign-up: a slow insert of a user row. */
async function slowSignup(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await testDb.pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'x', $2)`, [
    randomUUID(),
    `${randomUUID()}@example.test`,
  ]);
}

describe("SignupGate across processes (advisory lock)", () => {
  it("with no accounts, concurrent signups from separate processes admit exactly one", async () => {
    const gates = [processGate(), processGate(), processGate()];
    const results = await Promise.all(
      gates.flatMap((gate) => [gate.admit(slowSignup), gate.admit(slowSignup)]),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const { rows } = await testDb.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM "user"',
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("releases the lock afterwards, so a wiped database admits the next signup", async () => {
    const gate = processGate();
    expect(await gate.admit(slowSignup)).toBe(true);
    expect(await gate.admit(slowSignup)).toBe(false);

    await resetAuthTables(testDb.pool);
    expect(await processGate().admit(slowSignup)).toBe(true);
  });
});
