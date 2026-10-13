import type { PgBoss } from "pg-boss";
import { NOOP_QUEUE } from "./jobs.tokens";

export const JOBS_READINESS_TIMEOUT_MS = 2000;

/**
 * Resolves when pg-boss is started and can read its queue within the timeout, otherwise rejects.
 * The readiness registry turns a rejection into "down" and never exposes the error.
 */
export async function checkJobs(
  boss: Pick<PgBoss, "getQueue">,
  isStarted: () => boolean,
  timeoutMs: number = JOBS_READINESS_TIMEOUT_MS,
): Promise<void> {
  if (!isStarted()) throw new Error("jobs not started");
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("jobs readiness timeout")), timeoutMs);
  });
  try {
    const queue = await Promise.race([boss.getQueue(NOOP_QUEUE), timeout]);
    if (!queue) throw new Error("jobs queue missing");
  } finally {
    clearTimeout(timer);
  }
}
