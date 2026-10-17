import type {
  CreateIntegrationResponse,
  Integration,
  IntegrationListResponse,
  IntegrationResponse,
  PairingCodeResponse,
} from "@personal-api/contracts";

/**
 * Dashboard calls for /v1/integrations. Same-origin with the session cookie. Failures throw a
 * generic error (no body, URL or key in the message), and nothing here logs.
 */
export type { CreateIntegrationResponse, Integration, PairingCodeResponse };

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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  return (await (await send(method, path, body)).json()) as T;
}

export async function listIntegrations(): Promise<Integration[]> {
  return (await request<IntegrationListResponse>("GET", "/v1/integrations")).integrations;
}

export function createHttpIntegration(name: string): Promise<CreateIntegrationResponse> {
  return request("POST", "/v1/integrations", { kind: "http", name });
}

export async function createExtensionIntegration(name: string): Promise<Integration> {
  return (
    await request<IntegrationResponse>("POST", "/v1/integrations", {
      kind: "browser-extension",
      name,
    })
  ).integration;
}

export interface IssuedPairingCode {
  pairingCode: string;
  /** Time left on the code when the server answered, measured on the server's clock. */
  remainingMs: number;
}

/**
 * `expiresAt` is on the server's clock, so the time left is measured against the response's
 * `Date` header, not the browser's clock (which may be minutes off). That header has whole
 * seconds, so the server's "now" is taken as the end of its second: the countdown may end up to
 * a second early, never late. Without the header, the browser's clock is all there is.
 */
export async function issuePairingCode(integrationId: string): Promise<IssuedPairingCode> {
  const res = await send(
    "POST",
    `/v1/integrations/${encodeURIComponent(integrationId)}/pairing-code`,
  );
  const body = (await res.json()) as PairingCodeResponse;
  const serverDate = Date.parse(res.headers.get("date") ?? "");
  const serverNow = Number.isNaN(serverDate) ? Date.now() : serverDate + 999;
  return { pairingCode: body.pairingCode, remainingMs: Date.parse(body.expiresAt) - serverNow };
}

export async function revokeIntegration(integrationId: string): Promise<Integration> {
  return (
    await request<IntegrationResponse>(
      "POST",
      `/v1/integrations/${encodeURIComponent(integrationId)}/revoke`,
    )
  ).integration;
}
