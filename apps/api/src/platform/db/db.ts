import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "./schema";

export type Database = ReturnType<typeof createDb>;

export function createDb(pool: Pool) {
  return drizzle(pool, { schema });
}
