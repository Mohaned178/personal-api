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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`Request failed (${res.status}).`);
  return (await res.json()) as T;
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

export function issuePairingCode(integrationId: string): Promise<PairingCodeResponse> {
  return request("POST", `/v1/integrations/${encodeURIComponent(integrationId)}/pairing-code`);
}

export async function revokeIntegration(integrationId: string): Promise<Integration> {
  return (
    await request<IntegrationResponse>(
      "POST",
      `/v1/integrations/${encodeURIComponent(integrationId)}/revoke`,
    )
  ).integration;
}
