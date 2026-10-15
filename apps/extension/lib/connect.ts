// M2-02 connect logic (pure; every browser/network dependency is injected). STUB: not implemented yet.

export const CONNECTION_STORAGE_KEY = "connection";

export type ConnectErrorCode =
  | "server_url_invalid" // empty, garbage, or not http(s)
  | "server_url_insecure" // plain http to a non-loopback host
  | "pairing_code_empty" // blank pairing code (nothing was requested or sent)
  | "permission_denied" // browser.permissions.request resolved false (or rejected)
  | "code_invalid" // server: pairing.code_invalid
  | "rate_limited" // server: pairing.rate_limited (retryAfterSeconds from Retry-After)
  | "not_pairable" // server: pairing.integration_not_pairable
  | "network" // fetch rejected
  | "bad_response" // 2xx but not JSON / not pairResponseSchema
  | "server_error"; // any other non-2xx

export class ConnectError extends Error {
  readonly code: ConnectErrorCode;
  readonly retryAfterSeconds?: number;
  constructor(code: ConnectErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "ConnectError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface Connection {
  serverOrigin: string;
  ingestKey: string;
  integrationId: string;
  integrationName: string;
}

export interface ConnectDeps {
  permissions: {
    request(p: { origins: string[] }): Promise<boolean>;
    remove(p: { origins: string[] }): Promise<boolean>;
  };
  storage: {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(key: string): Promise<void>;
  };
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export function normalizeServerUrl(_input: string): { origin: string; originPattern: string } {
  throw new Error("not implemented");
}

export async function connect(
  _input: { serverUrl: string; pairingCode: string },
  _deps: ConnectDeps,
): Promise<Connection> {
  throw new Error("not implemented");
}

export async function disconnect(_deps: ConnectDeps): Promise<void> {
  throw new Error("not implemented");
}

export async function getConnection(_deps: ConnectDeps): Promise<Connection | null> {
  throw new Error("not implemented");
}
