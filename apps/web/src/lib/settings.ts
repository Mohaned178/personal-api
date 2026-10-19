import type { Settings, TimeZonesResponse, UpdateSettingsRequest } from "@personal-api/contracts";

/**
 * Dashboard calls for /v1/settings. Same-origin with the session cookie. Failures throw a generic
 * error (no body in the message), and nothing here logs.
 */
export type { Settings };

async function request<T>(method: string, body?: unknown, path = "/v1/settings"): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`Request failed (${res.status}).`);
  return (await res.json()) as T;
}

export const getSettings = () => request<Settings>("GET");
/** The names the server accepts: the database, not the browser, cuts the days. */
export const getTimeZones = async () =>
  (await request<TimeZonesResponse>("GET", undefined, "/v1/settings/time-zones")).timeZones;
export const updateSettings = (body: UpdateSettingsRequest) => request<Settings>("PATCH", body);
