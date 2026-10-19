import type {
  CreateReadKeyRequest,
  CreateReadKeyResponse,
  ReadKey,
  ReadKeyListResponse,
  ReadKeyResponse,
} from "@personal-api/contracts";

/**
 * Dashboard calls for /v1/keys (read keys). Same-origin with the session cookie. Failures throw a
 * generic error (no body, URL or key in the message), and nothing here logs.
 */
export type { CreateReadKeyRequest, CreateReadKeyResponse, ReadKey };

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

export async function listReadKeys(): Promise<ReadKey[]> {
  return (await request<ReadKeyListResponse>("GET", "/v1/keys")).readKeys;
}

/** The answer carries the plaintext key: callers keep it in component state only. */
export function createReadKey(body: CreateReadKeyRequest): Promise<CreateReadKeyResponse> {
  return request("POST", "/v1/keys", body);
}

export async function revokeReadKey(id: string): Promise<ReadKey> {
  return (await request<ReadKeyResponse>("POST", `/v1/keys/${encodeURIComponent(id)}/revoke`))
    .readKey;
}
