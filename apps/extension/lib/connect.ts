// M2-02 connect logic (pure; every browser/network dependency is injected).

import {
  PAIRING_CODE_INVALID_CODE,
  PAIRING_NOT_PAIRABLE_CODE,
  PAIRING_RATE_LIMITED_CODE,
  pairResponseSchema,
} from "@personal-api/contracts";

export const CONNECTION_STORAGE_KEY = "connection";

/** Ingest keys only ever carry this prefix (invariant 5). */
const INGEST_KEY_PREFIX = "pa_ing_";

/** Plain http is only allowed to the user's own machine, never to a remote host. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Hostnames that can safely go into a permission match pattern: plain DNS labels or IPv4
 * (after the URL parser's punycode/lowercase step) or a bracketed IPv6 literal. Anything else,
 * notably `*`, would widen the requested permission.
 */
const HOSTNAME_PATTERN = /^[a-z0-9.-]+$/;
const IPV6_HOSTNAME_PATTERN = /^\[[0-9a-f:.]+\]$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PERMISSION_DENIED_MESSAGE = "Permission for the server was not granted. Nothing was sent.";

const NETWORK_MESSAGE =
  "Could not reach the server, so the pairing code may not have been used. If this keeps failing, request a new code in the dashboard.";

const BAD_RESPONSE_MESSAGE =
  "The server sent an unexpected response, so the pairing code may not have been used. If this keeps failing, request a new code in the dashboard.";

const SERVER_ERROR_MESSAGE =
  "The server could not complete the pairing. If this keeps failing, request a new code in the dashboard.";

const URL_INVALID_MESSAGE = "Enter a valid server URL, for example https://api.example.com.";

const URL_INSECURE_MESSAGE =
  "Plain http is only allowed for localhost. Use an https:// server URL instead.";

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

/**
 * The local queue, as `connect` needs it (M2-R fix): a store (`QueueStore`) satisfies this. When it
 * is given, a successful pairing for a DIFFERENT owner (origin or integration) discards the old
 * queue and records the new owner; the same owner keeps the queue.
 */
export interface ConnectQueue {
  stats(): Promise<{ depth: number }>;
  getOwner(): Promise<{ serverOrigin: string; integrationId: string } | null>;
  setOwner(owner: { serverOrigin: string; integrationId: string }): Promise<void>;
  clear(): Promise<number>;
}

export interface ConnectDeps {
  queue?: ConnectQueue;
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

/**
 * Accepts only an absolute http(s) URL. Plain http is limited to loopback hosts. Returns the
 * canonical origin (credentials, path, query and fragment dropped, default port removed) and the
 * permission match pattern for that origin (match patterns ignore ports).
 */
export function normalizeServerUrl(input: string): { origin: string; originPattern: string } {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new ConnectError("server_url_invalid", URL_INVALID_MESSAGE);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConnectError("server_url_invalid", URL_INVALID_MESSAGE);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConnectError("server_url_invalid", URL_INVALID_MESSAGE);
  }

  const hostname = url.hostname.toLowerCase();
  if (!HOSTNAME_PATTERN.test(hostname) && !IPV6_HOSTNAME_PATTERN.test(hostname)) {
    throw new ConnectError("server_url_invalid", URL_INVALID_MESSAGE);
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTNAMES.has(hostname)) {
    throw new ConnectError("server_url_insecure", URL_INSECURE_MESSAGE);
  }

  return { origin: url.origin, originPattern: `${url.protocol}//${hostname}/*` };
}

/**
 * Requests the origin permission synchronously (Firefox only shows the prompt inside a user
 * gesture, so nothing may await before that call), exchanges the code for an ingest key and
 * stores the connection. Fails closed: nothing is stored unless the whole flow succeeded.
 */
export async function connect(
  input: { serverUrl: string; pairingCode: string },
  deps: ConnectDeps,
): Promise<Connection> {
  const { origin, originPattern } = normalizeServerUrl(input.serverUrl);
  const pairingCode = input.pairingCode.trim();
  if (pairingCode.length === 0) {
    throw new ConnectError("pairing_code_empty", "Enter the pairing code from the dashboard.");
  }

  // Keep this call in the synchronous part of the function: moving any await above it breaks the
  // user gesture requirement in Firefox.
  let permission: Promise<boolean>;
  try {
    permission = deps.permissions.request({ origins: [originPattern] });
  } catch {
    throw new ConnectError("permission_denied", PERMISSION_DENIED_MESSAGE);
  }

  let granted: boolean;
  try {
    granted = await permission;
  } catch {
    throw new ConnectError("permission_denied", PERMISSION_DENIED_MESSAGE);
  }
  if (!granted) {
    throw new ConnectError("permission_denied", PERMISSION_DENIED_MESSAGE);
  }

  let response: Response;
  try {
    response = await deps.fetch(`${origin}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingCode }),
      credentials: "omit",
      redirect: "error",
    });
  } catch {
    throw new ConnectError("network", NETWORK_MESSAGE);
  }

  if (!response.ok) {
    throw await pairingFailure(response);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ConnectError("bad_response", BAD_RESPONSE_MESSAGE);
  }

  const parsed = pairResponseSchema.safeParse(payload);
  if (!parsed.success || !isIngestKey(parsed.data.ingestKey.key)) {
    throw new ConnectError("bad_response", BAD_RESPONSE_MESSAGE);
  }

  const connection: Connection = {
    serverOrigin: origin,
    ingestKey: parsed.data.ingestKey.key,
    integrationId: parsed.data.integration.id,
    integrationName: parsed.data.integration.name,
  };
  await adoptQueueOwner(deps.queue, connection);
  await deps.storage.set({ [CONNECTION_STORAGE_KEY]: connection });
  return connection;
}

/**
 * After a successful pairing only: a queue that belongs to another owner (or to none we can prove)
 * is discarded so its events can never reach the new server or account, then the new owner is
 * recorded. The same owner keeps its queue. If this fails, the pairing fails and nothing is stored.
 */
async function adoptQueueOwner(queue: ConnectQueue | undefined, connection: Connection) {
  if (queue === undefined) return;
  const owner = { serverOrigin: connection.serverOrigin, integrationId: connection.integrationId };
  const current = await queue.getOwner();
  const same =
    current !== null &&
    current.serverOrigin === owner.serverOrigin &&
    current.integrationId === owner.integrationId;
  if (!same && (await queue.stats()).depth > 0) await queue.clear();
  await queue.setOwner(owner);
}

/** Removes the stored connection and, best effort, the origin permission. Never throws for that. */
export async function disconnect(deps: ConnectDeps): Promise<void> {
  const connection = await getConnection(deps);
  const originPattern =
    connection === null ? null : normalizeServerUrl(connection.serverOrigin).originPattern;

  await deps.storage.remove(CONNECTION_STORAGE_KEY);

  if (originPattern !== null) {
    try {
      await deps.permissions.remove({ origins: [originPattern] });
    } catch {
      // Best effort: the stored key is already gone, so capture cannot continue.
    }
  }
}

/** Returns the stored connection, or null when absent, malformed or unreadable (fail closed). */
export async function getConnection(deps: ConnectDeps): Promise<Connection | null> {
  try {
    const stored = await deps.storage.get(CONNECTION_STORAGE_KEY);
    return parseStoredConnection(stored[CONNECTION_STORAGE_KEY]);
  } catch {
    return null;
  }
}

function parseStoredConnection(value: unknown): Connection | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const { serverOrigin, ingestKey, integrationId, integrationName } = candidate;
  if (
    typeof serverOrigin !== "string" ||
    typeof ingestKey !== "string" ||
    typeof integrationId !== "string" ||
    typeof integrationName !== "string" ||
    integrationName.trim().length === 0 ||
    !isIngestKey(ingestKey) ||
    !UUID_PATTERN.test(integrationId)
  ) {
    return null;
  }

  let origin: string;
  try {
    origin = normalizeServerUrl(serverOrigin).origin;
  } catch {
    return null;
  }

  return { serverOrigin: origin, ingestKey, integrationId, integrationName };
}

function isIngestKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(INGEST_KEY_PREFIX) &&
    value.length > INGEST_KEY_PREFIX.length
  );
}

async function pairingFailure(response: Response): Promise<ConnectError> {
  let code: string | undefined;
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      const candidate = (body as Record<string, unknown>).code;
      if (typeof candidate === "string") {
        code = candidate;
      }
    }
  } catch {
    // Not JSON (for example an HTML error page): fall through to server_error.
  }

  if (code === PAIRING_CODE_INVALID_CODE) {
    return new ConnectError(
      "code_invalid",
      "The pairing code is invalid or has expired. Request a new code in the dashboard.",
    );
  }
  if (code === PAIRING_NOT_PAIRABLE_CODE) {
    return new ConnectError(
      "not_pairable",
      "This integration cannot be paired right now. Check it in the dashboard.",
    );
  }
  if (code === PAIRING_RATE_LIMITED_CODE) {
    const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
    return new ConnectError(
      "rate_limited",
      retryAfterSeconds === undefined
        ? "Too many pairing attempts. Try again later."
        : `Too many pairing attempts. Try again in ${retryAfterSeconds} seconds.`,
      retryAfterSeconds,
    );
  }
  return new ConnectError("server_error", SERVER_ERROR_MESSAGE);
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const seconds = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}
