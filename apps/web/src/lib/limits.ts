import type { Limit, LimitListResponse, LimitSave } from "@personal-api/contracts";

/**
 * Dashboard calls for /v1/limits. Same-origin with the session cookie. A failure throws a
 * `LimitsError` with the status and the problem `code` only (never the body, which could repeat a
 * site), and nothing here logs.
 */
export type { Limit, LimitSave };

export class LimitsError extends Error {
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
    throw new LimitsError(res.status, typeof problem?.code === "string" ? problem.code : null);
  }
  return res;
}

export async function listLimits(): Promise<Limit[]> {
  return ((await (await send("GET", "/v1/limits")).json()) as LimitListResponse).limits;
}

export async function createLimit(save: LimitSave): Promise<void> {
  await send("POST", "/v1/limits", save);
}

export async function replaceLimit(id: string, save: LimitSave): Promise<void> {
  await send("PUT", `/v1/limits/${encodeURIComponent(id)}`, save);
}

export async function deleteLimit(id: string): Promise<void> {
  await send("DELETE", `/v1/limits/${encodeURIComponent(id)}`);
}
