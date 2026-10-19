import type { RetentionResponse, RetentionScope } from "@personal-api/contracts";

/**
 * Dashboard calls for /v1/retention. Same-origin with the session cookie. Failures throw a generic
 * error (no body in the message), and nothing here logs.
 */
export type { RetentionResponse, RetentionScope };

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`Request failed (${res.status}).`);
  return res;
}

export async function getRetention(): Promise<RetentionResponse> {
  return (await (await send("GET", "/v1/retention")).json()) as RetentionResponse;
}

export async function putRetention(
  scope: RetentionScope,
  target: string,
  days: number,
): Promise<void> {
  await send("PUT", `/v1/retention/${scope}/${encodeURIComponent(target)}`, { days });
}

export async function deleteRetention(scope: RetentionScope, target: string): Promise<void> {
  await send("DELETE", `/v1/retention/${scope}/${encodeURIComponent(target)}`);
}
