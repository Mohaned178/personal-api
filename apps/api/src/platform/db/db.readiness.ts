import type { Pool } from "pg";

export const DB_READINESS_TIMEOUT_MS = 2000;

/**
 * Resolves if `SELECT 1` succeeds within the timeout, otherwise rejects. The registry turns a
 * rejection into "down" and never exposes the error, so connection details cannot leak.
 */
export async function checkDb(
  pool: Pick<Pool, "query">,
  timeoutMs: number = DB_READINESS_TIMEOUT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("db readiness timeout")), timeoutMs);
  });
  try {
    await Promise.race([pool.query("SELECT 1"), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
