import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { checkDb } from "./db.readiness";
import { appMeta } from "./schema";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb?.stop();
});

describe("database layer (Testcontainers)", () => {
  it("runs the pinned Postgres 18 and supports uuidv7()", async () => {
    const version = await testDb.pool.query("SHOW server_version_num");
    expect(Number(version.rows[0].server_version_num)).toBeGreaterThanOrEqual(180000);
    const id = await testDb.pool.query("SELECT uuidv7() AS id");
    expect(id.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("applied the migrations: app_meta accepts writes and reads", async () => {
    await testDb.db.insert(appMeta).values({ key: "bootstrap", value: "ok" });
    const rows = await testDb.db.select().from(appMeta).where(eq(appMeta.key, "bootstrap"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe("ok");
  });

  it("readiness check passes while up and fails when nothing is listening", async () => {
    await expect(checkDb(testDb.pool)).resolves.toBeUndefined();
    const url = new URL(testDb.url);
    url.port = "1"; // nothing listens here: simulates the DB being down
    const dead = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 500 });
    dead.on("error", () => {});
    await expect(checkDb(dead)).rejects.toThrow();
    await dead.end();
  });
});
