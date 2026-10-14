import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, startTestDatabase, type TestDatabase } from "../../../test/postgres";
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
  describe("integrations_kind_check (M2-00a rename)", () => {
    const userId = "kind-check-user";

    beforeAll(async () => {
      await testDb.pool.query(
        `INSERT INTO "user" (id, name, email) VALUES ($1, 'k', 'kind-check@example.test')`,
        [userId],
      );
    });

    const insertKind = (kind: string) =>
      testDb.pool.query(`INSERT INTO integrations (user_id, kind, name) VALUES ($1, $2, 'x')`, [
        userId,
        kind,
      ]);

    it("accepts browser-extension and http, rejects the old chrome-extension kind", async () => {
      await insertKind("browser-extension");
      await insertKind("http");
      await expect(insertKind("chrome-extension")).rejects.toThrow(/integrations_kind_check/);
      await expect(insertKind("firefox-extension")).rejects.toThrow(/integrations_kind_check/);
    });

    it("migration 0003 rewrites existing chrome-extension rows and restores the constraint", async () => {
      const migration = readFileSync(
        path.join(MIGRATIONS_FOLDER, "0003_demonic_mister_sinister.sql"),
        "utf8",
      );
      const client = await testDb.pool.connect();
      try {
        await client.query("BEGIN");
        // Rewind to the pre-0003 state, with a legacy row, then re-apply the migration.
        await client.query(`ALTER TABLE integrations DROP CONSTRAINT integrations_kind_check`);
        await client.query(
          `ALTER TABLE integrations ADD CONSTRAINT integrations_kind_check CHECK (kind IN ('chrome-extension', 'http', 'browser-extension'))`,
        );
        await client.query(
          `INSERT INTO integrations (user_id, kind, name) VALUES ($1, 'chrome-extension', 'legacy')`,
          [userId],
        );
        for (const statement of migration.split("--> statement-breakpoint")) {
          await client.query(statement);
        }
        const legacy = await client.query(`SELECT kind FROM integrations WHERE name = 'legacy'`);
        expect(legacy.rows[0]?.kind).toBe("browser-extension");
        const left = await client.query(
          `SELECT count(*)::int AS n FROM integrations WHERE kind = 'chrome-extension'`,
        );
        expect(left.rows[0]?.n).toBe(0);
        await expect(
          client.query(
            `INSERT INTO integrations (user_id, kind, name) VALUES ($1, 'chrome-extension', 'z')`,
            [userId],
          ),
        ).rejects.toThrow(/integrations_kind_check/);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  });
});
