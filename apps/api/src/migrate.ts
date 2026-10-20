import { join } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { configSchema } from "./config/config";
import { createDb } from "./platform/db/db";

/**
 * Applies the drizzle/ migrations and exits. The production stack runs it once as the `migrate`
 * service (docker-compose.prod.yml), before the API and the worker start. Errors name the failure
 * and never echo DATABASE_URL.
 */
async function main(): Promise<void> {
  // Same DATABASE_URL rules as the app (explicit port other than 5432, no host or port overrides).
  const url = configSchema.shape.DATABASE_URL.safeParse(process.env.DATABASE_URL);
  if (!url.success) {
    throw new Error(`Invalid DATABASE_URL: ${url.error.issues.map((i) => i.message).join("; ")}`);
  }
  const pool = new Pool({ connectionString: url.data });
  try {
    await migrate(createDb(pool), { migrationsFolder: join(__dirname, "../drizzle") });
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`migrations failed: ${reason}\n`);
  process.exitCode = 1;
});
