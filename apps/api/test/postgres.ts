import { readFileSync } from "node:fs";
import path from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { createDb } from "../src/platform/db/db";

const REPO_ROOT = path.resolve(__dirname, "../../..");
export const MIGRATIONS_FOLDER = path.resolve(__dirname, "../drizzle");

/** docker-compose.yml is the single place the Postgres image tag is pinned. */
export function readComposePostgresImage(): string {
  const compose = readFileSync(path.join(REPO_ROOT, "docker-compose.yml"), "utf8");
  const match = /^\s*image:\s*(postgres:\S+)\s*$/m.exec(compose);
  if (!match?.[1]) throw new Error("no postgres image found in docker-compose.yml");
  return match[1];
}

export interface TestDatabase {
  url: string;
  pool: Pool;
  db: ReturnType<typeof createDb>;
  stop: () => Promise<void>;
}

/** Starts a fresh Postgres (same image as compose), applies all migrations, returns a client. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(readComposePostgresImage()).start();
  const url = container.getConnectionUri();
  const pool = new Pool({ connectionString: url });
  const db = createDb(pool);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } catch (error) {
    await pool.end();
    await container.stop();
    throw error;
  }
  return {
    url,
    pool,
    db,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
