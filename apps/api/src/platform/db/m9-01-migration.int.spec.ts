/**
 * M9-01 migration (0013): drops the endpoints table and everything that only read keys used.
 * The default test database is empty, so this one is migrated to 0012 first, filled with what a
 * v1.1 server holds (endpoints, read keys, an endpoint-bound key, a revoked read key, an ingest
 * key, a pairing code), and then migrated to the end the way an upgrade would.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, readComposePostgresImage } from "../../../test/postgres";
import { createDb } from "./db";

/** The last migration a v1.1 server has (0012_backfill_event_expiry). */
const LAST_V1_1_IDX = 12;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let truncatedFolder: string | undefined;

const sql = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;

beforeAll(async () => {
  container = await new PostgreSqlContainer(readComposePostgresImage()).start();
  pool = new Pool({ connectionString: container.getConnectionUri() });

  // A copy of the migrations folder whose journal stops at the v1.1 state.
  truncatedFolder = mkdtempSync(path.join(tmpdir(), "pa-migrations-"));
  cpSync(MIGRATIONS_FOLDER, truncatedFolder, { recursive: true });
  const journalPath = path.join(truncatedFolder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number }>;
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= LAST_V1_1_IDX);
  writeFileSync(journalPath, JSON.stringify(journal));

  await migrate(createDb(pool), { migrationsFolder: truncatedFolder });
}, 240_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  if (truncatedFolder) rmSync(truncatedFolder, { recursive: true, force: true });
});

describe("migration 0013 on a database that held endpoints and read keys", () => {
  it("keeps ingest keys, integrations and pairing codes, and drops the rest", async () => {
    await sql(`INSERT INTO "user" (id, name, email) VALUES ('u1', 'U', 'u1@example.test')`);
    const [integration] = await sql(
      `INSERT INTO integrations (user_id, kind, name) VALUES ('u1', 'browser-extension', 'fx') RETURNING id`,
    );
    const [endpoint] = await sql(
      `INSERT INTO endpoints (user_id, slug, definition, enabled)
       VALUES ('u1', 'stats', '{}'::jsonb, true) RETURNING id`,
    );
    const key = (
      kind: string,
      hash: string,
      extra: {
        integrationId?: string;
        endpointId?: string;
        scopes?: string[];
        name?: string;
        revokedAt?: Date;
      } = {},
    ) =>
      sql(
        `INSERT INTO api_keys (user_id, kind, integration_id, endpoint_id, prefix, hash, scopes, name, revoked_at)
         VALUES ('u1', $1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
        [
          kind,
          extra.integrationId ?? null,
          extra.endpointId ?? null,
          kind === "ingest" ? "pa_ing_abcdef" : "pa_read_abcdef",
          hash,
          JSON.stringify(extra.scopes ?? []),
          extra.name ?? null,
          extra.revokedAt ?? null,
        ],
      );
    await key("ingest", "h-ingest", { integrationId: integration.id });
    await key("read", "h-read", { scopes: ["events:read"], name: "mine" });
    await key("read", "h-read-revoked", { revokedAt: new Date() });
    await key("read", "h-endpoint", {
      scopes: [`endpoint:${endpoint.id}`],
      endpointId: endpoint.id,
    });
    await sql(
      `INSERT INTO pairing_codes (user_id, integration_id, code_hash, expires_at)
       VALUES ('u1', $1, 'h-code', now() + interval '10 minutes')`,
      [integration.id],
    );

    await migrate(createDb(pool), { migrationsFolder: MIGRATIONS_FOLDER });

    // The migration after 0012 was applied (the journal is truncated for the first run only).
    const applied = await sql(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    expect(applied[0].n).toBeGreaterThan(LAST_V1_1_IDX + 1);

    // The endpoints table is gone.
    expect((await sql(`SELECT to_regclass('public.endpoints') AS t`))[0].t).toBeNull();

    // Only the ingest key is left, and it is intact.
    const keys = await sql(`SELECT kind, hash, integration_id FROM api_keys ORDER BY hash`);
    expect(keys).toEqual([{ kind: "ingest", hash: "h-ingest", integration_id: integration.id }]);
    expect(await sql(`SELECT 1 FROM pairing_codes WHERE code_hash = 'h-code'`)).toHaveLength(1);
    expect(await sql(`SELECT 1 FROM integrations WHERE id = $1`, [integration.id])).toHaveLength(1);

    // The columns only read keys used are gone.
    const columns = await sql(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'api_keys'`,
    );
    const names = columns.map((c) => c.column_name as string);
    for (const gone of ["endpoint_id", "name", "restriction", "scopes"]) {
      expect(names).not.toContain(gone);
    }
  });

  it("no longer lets a read key be stored", async () => {
    await expect(
      sql(
        `INSERT INTO api_keys (user_id, kind, integration_id, prefix, hash)
         VALUES ('u1', 'read', (SELECT id FROM integrations LIMIT 1), 'pa_read_abcdef', 'h-new-read')`,
      ),
    ).rejects.toThrow(/api_keys_kind_check/);
  });
});
