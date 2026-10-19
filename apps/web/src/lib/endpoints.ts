import type {
  Endpoint,
  EndpointInput,
  EndpointKeyResponse,
  EndpointListResponse,
  EndpointResponse,
  PreviewEndpointResponse,
  SavedQueryResult,
} from "@personal-api/contracts";

/**
 * Dashboard calls for /v1/endpoints. Same-origin with the session cookie. Failures throw a generic
 * error (no body, URL or key in the message), and nothing here logs.
 */
export type { Endpoint, EndpointInput, SavedQueryResult };

/** A rejected request, so a caller can tell a bad definition (400) from a taken slug (409). */
export class EndpointRequestError extends Error {
  constructor(readonly status: number) {
    super(`Request failed (${status}).`);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) throw new EndpointRequestError(res.status);
  return (await res.json()) as T;
}

export async function listEndpoints(): Promise<Endpoint[]> {
  return (await request<EndpointListResponse>("GET", "/v1/endpoints")).endpoints;
}

/** The answer carries the plaintext key: callers keep it in component state only. */
export function createEndpoint(body: EndpointInput): Promise<EndpointKeyResponse> {
  return request("POST", "/v1/endpoints", body);
}

export async function replaceEndpoint(id: string, body: EndpointInput): Promise<Endpoint> {
  return (await request<EndpointResponse>("PUT", `/v1/endpoints/${encodeURIComponent(id)}`, body))
    .endpoint;
}

export async function deleteEndpoint(id: string): Promise<void> {
  await request<EndpointResponse>("DELETE", `/v1/endpoints/${encodeURIComponent(id)}`);
}

/** The answer carries the new plaintext key: callers keep it in component state only. */
export function rotateEndpointKey(id: string): Promise<EndpointKeyResponse> {
  return request("POST", `/v1/endpoints/${encodeURIComponent(id)}/rotate-key`);
}

export async function previewEndpoint(definition: unknown): Promise<SavedQueryResult> {
  return (await request<PreviewEndpointResponse>("POST", "/v1/endpoints/preview", { definition }))
    .result;
}
