import type {
  FocusResponse,
  FocusSession,
  FocusStart,
  Schedule,
  ScheduleListResponse,
  ScheduleSave,
} from "@personal-api/contracts";

/**
 * Dashboard calls for /v1/focus and /v1/schedules (M9-06). Same-origin with the session cookie. A
 * failure throws a `BlockingError` with the status and the problem `code` only (never the body,
 * which could repeat a site), and nothing here logs.
 */
export type { FocusSession, FocusStart, Schedule, ScheduleSave };

export class BlockingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`Request failed (${status}).`);
  }
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    const problem = (await res.json().catch(() => null)) as { code?: unknown } | null;
    throw new BlockingError(res.status, typeof problem?.code === "string" ? problem.code : null);
  }
  return res;
}

export async function getFocus(): Promise<FocusSession | null> {
  return ((await (await send("GET", "/v1/focus")).json()) as FocusResponse).session;
}

export async function startFocus(start: FocusStart): Promise<void> {
  await send("POST", "/v1/focus", start);
}

/** Ending a session that is already gone (it ran out, or ended elsewhere) is done, not a failure. */
export async function endFocus(): Promise<void> {
  try {
    await send("DELETE", "/v1/focus");
  } catch (error) {
    if (!(error instanceof BlockingError && error.code === "focus.not_found")) throw error;
  }
}

export async function listSchedules(): Promise<Schedule[]> {
  return ((await (await send("GET", "/v1/schedules")).json()) as ScheduleListResponse).schedules;
}

export async function createSchedule(save: ScheduleSave): Promise<void> {
  await send("POST", "/v1/schedules", save);
}

export async function replaceSchedule(id: string, save: ScheduleSave): Promise<void> {
  await send("PUT", `/v1/schedules/${encodeURIComponent(id)}`, save);
}

export async function deleteSchedule(id: string): Promise<void> {
  await send("DELETE", `/v1/schedules/${encodeURIComponent(id)}`);
}
