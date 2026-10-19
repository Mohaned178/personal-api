import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { createAppRouter } from "@/router";

/**
 * Fake backend for the auth pages. Contract assumed from docs/PLAN.md section 6 and
 * apps/api/src/modules/auth: GET /v1/me (200 user | 401), Better Auth under /api/auth/*,
 * and GET /v1/setup/status ({ needsSetup, signupOpen }), the public first-run probe (see the report).
 */
export interface FakeBackend {
  authed: boolean;
  needsSetup: boolean;
  signupOpen: boolean;
  /** When true, GET /v1/me rejects with a network error. */
  meNetworkError?: boolean;
  /** Override sign-in / sign-up outcomes with an error status. */
  signInStatus?: number | undefined;
  signUpStatus?: number | undefined;
  /** Integrations store for /v1/integrations. Leave unset and those routes answer 404. */
  integrations?: FakeIntegration[];
  /** Lifetime of the pairing codes the fake issues, in ms. */
  codeTtlMs?: number;
  /** The fake server's clock (defaults to `Date.now`); sent as the pairing response's `Date` header. */
  serverNow?: () => number;
  /** Stored events (newest first) for /v1/events. Leave unset and those routes answer 404. */
  events?: FakeEvent[];
  /** Response for GET /v1/diagnostics. Leave unset and that route answers 404. */
  diagnostics?: unknown;
  /** Rules store for /v1/rules. Leave unset and those routes answer 404. */
  rules?: FakeRuleStore;
  /** Time zone for /v1/settings. Leave unset and those routes answer 404. */
  timeZone?: string;
  /** Names for GET /v1/settings/time-zones (what the database accepts). */
  timeZones?: string[];
  /** Answer PATCH /v1/settings with this error status. */
  rejectSettings?: number;
  /** Read keys for /v1/keys. Leave unset and those routes answer 404. */
  readKeys?: FakeReadKey[];
  /** Answer the next POST /v1/keys with this error status. */
  rejectKeyCreate?: number | undefined;
  /** Endpoints for /v1/endpoints. Leave unset and those routes answer 404. */
  endpoints?: FakeEndpoint[];
  /** Body of the next POST /v1/endpoints/preview answer (default: an empty count_by_day result). */
  previewResult?: unknown;
  /** Answer the next POST /v1/endpoints/preview with this error status. */
  rejectPreview?: number | undefined;
  /** Answer the next create/replace of an endpoint with this error status. */
  rejectEndpointSave?: number | undefined;
  calls: { method: string; path: string; body: unknown; search?: string }[];
}

export interface FakeEndpoint {
  id: string;
  slug: string;
  enabled: boolean;
  definition: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface FakeRule {
  id: string;
  [key: string]: unknown;
}

export interface FakeRuleStore {
  version: number;
  rules: FakeRule[];
  /** Body of the next POST /v1/rules/test answer. */
  testResult?: unknown;
  /** Answer the next create/update with a 400 listing these issues. */
  rejectWith?: { path: (string | number)[]; message: string }[] | undefined;
}

function rulesRoute(
  b: FakeBackend,
  method: string,
  pathname: string,
  body: unknown,
): Response | null {
  const store = b.rules;
  if (!store || !pathname.startsWith("/v1/rules")) return null;
  const sorted = () =>
    [...store.rules].sort(
      (x, y) => Number(x.priority) - Number(y.priority) || (x.id < y.id ? -1 : 1),
    );
  const reject = () => {
    const issues = store.rejectWith;
    store.rejectWith = undefined;
    return issues ? json(400, { code: "request.invalid", issues }) : null;
  };
  if (pathname === "/v1/rules/test" && method === "POST") {
    return json(200, store.testResult ?? { decision: "error", reason: "failed" });
  }
  if (pathname === "/v1/rules") {
    if (method === "GET") return json(200, { version: store.version, rules: sorted() });
    if (method === "POST") {
      const rejected = reject();
      if (rejected) return rejected;
      const rule = { id: crypto.randomUUID(), ...(body as object) };
      store.rules.push(rule);
      store.version += 1;
      return json(201, { rule, version: store.version });
    }
  }
  const id = /^\/v1\/rules\/([^/]+)$/.exec(pathname)?.[1];
  const index = store.rules.findIndex((r) => r.id === id);
  if (index < 0) return json(404, { code: "rule.not_found" });
  if (method === "PUT") {
    const rejected = reject();
    if (rejected) return rejected;
    store.rules[index] = { id: store.rules[index]?.id as string, ...(body as object) };
    store.version += 1;
    return json(200, { rule: store.rules[index], version: store.version });
  }
  if (method === "DELETE") {
    store.rules.splice(index, 1);
    store.version += 1;
    return json(200, { version: store.version });
  }
  return null;
}

export interface FakeEvent {
  id: string;
  integrationId: string;
  type: string;
  typeVersion: number;
  occurredAt: string;
  receivedAt: string;
  origin: "collected" | "imported" | "derived";
  data: Record<string, unknown>;
  tags: string[];
  trace?: unknown;
}

export const EVENTS_PAGE_SIZE = 50;

/** Filters like the API does; the cursor is the offset of the next row (opaque to the page). */
function eventsRoute(b: FakeBackend, method: string, url: URL, body: unknown): Response | null {
  const list = b.events;
  if (!list || url.pathname !== "/v1/events") return null;
  if (method === "DELETE") {
    const ids = new Set((body as { ids: string[] }).ids);
    const before = list.length;
    b.events = list.filter((e) => !ids.has(e.id));
    return json(200, { deleted: before - b.events.length });
  }
  if (method !== "GET") return null;
  const q = url.searchParams;
  const rows = list.filter(
    (e) =>
      (!q.get("source") || e.integrationId === q.get("source")) &&
      (!q.get("type") || e.type === q.get("type")) &&
      (!q.get("domain") || e.data.domain === q.get("domain")) &&
      (!q.get("from") || e.occurredAt >= (q.get("from") as string)) &&
      (!q.get("to") || e.occurredAt < (q.get("to") as string)),
  );
  const start = Number(q.get("cursor") ?? 0);
  const end = start + EVENTS_PAGE_SIZE;
  return json(200, {
    events: rows.slice(start, end),
    nextCursor: end < rows.length ? String(end) : null,
  });
}

export interface FakeIntegration {
  id: string;
  kind: "http" | "browser-extension";
  name: string;
  defaultPolicy: "deny";
  status: "active" | "revoked";
  lastSeenAt: string | null;
  createdAt: string;
}

export interface FakeReadKey {
  id: string;
  name: string | null;
  prefix: string;
  scopes: string[];
  restriction: { sources?: string[]; types?: string[] } | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export const ENDPOINT_KEY = "pa_read_endpointendpointendpoint";
export const READ_KEY = "pa_read_secretsecretsecret";

function keysRoute(
  b: FakeBackend,
  method: string,
  pathname: string,
  body: unknown,
): Response | null {
  const list = b.readKeys;
  if (!list) return null;
  const route = `${method} ${pathname}`;
  if (route === "GET /v1/keys") return json(200, { readKeys: list });
  if (route === "POST /v1/keys") {
    if (b.rejectKeyCreate) {
      const status = b.rejectKeyCreate;
      b.rejectKeyCreate = undefined;
      return json(status, { code: "request.invalid" });
    }
    const request = body as Pick<FakeReadKey, "scopes" | "restriction"> & { name?: string };
    const readKey: FakeReadKey = {
      id: crypto.randomUUID(),
      name: request.name ?? null,
      prefix: "pa_read_secret",
      scopes: request.scopes,
      restriction: request.restriction ?? null,
      createdAt: "2026-10-19T00:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
    };
    list.unshift(readKey);
    return json(201, { readKey, key: READ_KEY });
  }
  const id = /^\/v1\/keys\/([^/]+)\/revoke$/.exec(pathname)?.[1];
  const target = method === "POST" ? list.find((k) => k.id === id) : undefined;
  if (!target) return null;
  target.revokedAt ??= "2026-10-19T01:00:00.000Z";
  return json(200, { readKey: target });
}

export const PAIRING_CODE = "ABCD-EFGH-JKLM-NPQR-STUV";
export const INGEST_KEY = "pa_ing_secretsecretsecret";

function integrationsRoute(
  b: FakeBackend,
  method: string,
  pathname: string,
  body: unknown,
): Response | null {
  const list = b.integrations;
  if (!list) return null;
  const route = `${method} ${pathname}`;
  if (route === "GET /v1/integrations") return json(200, { integrations: list });
  if (route === "POST /v1/integrations") {
    const { kind, name } = body as Pick<FakeIntegration, "kind" | "name">;
    const integration: FakeIntegration = {
      id: crypto.randomUUID(),
      kind,
      name,
      defaultPolicy: "deny",
      status: "active",
      lastSeenAt: null,
      createdAt: "2026-10-17T00:00:00.000Z",
    };
    list.push(integration);
    if (kind !== "http") return json(201, { integration });
    const ingestKey = { id: crypto.randomUUID(), key: INGEST_KEY, prefix: "pa_ing_secr" };
    return json(201, { integration, ingestKey });
  }
  const m = /^\/v1\/integrations\/([^/]+)\/(pairing-code|revoke)$/.exec(pathname);
  const target = m && method === "POST" ? list.find((i) => i.id === m[1]) : undefined;
  if (!m || !target) return null;
  if (m[2] === "revoke") {
    target.status = "revoked";
    return json(200, { integration: target });
  }
  const now = (b.serverNow ?? Date.now)();
  const expiresAt = new Date(now + (b.codeTtlMs ?? 600_000)).toISOString();
  return json(201, { pairingCode: PAIRING_CODE, expiresAt }, { date: new Date(now).toUTCString() });
}

export const USER = { id: "u1", email: "alice@example.test", name: "Alice" };
export const PASSWORD = "correct-horse-battery";

export function makeBackend(init: Partial<FakeBackend> = {}): FakeBackend {
  return { authed: false, needsSetup: false, signupOpen: true, calls: [], ...init };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": status >= 400 ? "application/problem+json" : "application/json",
      ...headers,
    },
  });
}

function endpointsRoute(
  b: FakeBackend,
  method: string,
  pathname: string,
  body: unknown,
): Response | null {
  const list = b.endpoints;
  if (!list) return null;
  const route = `${method} ${pathname}`;
  if (route === "GET /v1/endpoints") return json(200, { endpoints: list });
  if (route === "POST /v1/endpoints/preview") {
    if (b.rejectPreview) {
      const status = b.rejectPreview;
      b.rejectPreview = undefined;
      return json(status, { code: "request.invalid" });
    }
    return json(200, {
      result: b.previewResult ?? { kind: "count_by_day", rows: [], truncated: false },
    });
  }
  const input = body as Pick<FakeEndpoint, "slug" | "enabled" | "definition">;
  if (route === "POST /v1/endpoints") {
    if (b.rejectEndpointSave) {
      const status = b.rejectEndpointSave;
      b.rejectEndpointSave = undefined;
      return json(status, { code: "endpoint.slug_taken" });
    }
    const endpoint: FakeEndpoint = {
      id: crypto.randomUUID(),
      slug: input.slug,
      enabled: input.enabled ?? true,
      definition: input.definition,
      createdAt: "2026-10-19T00:00:00.000Z",
      updatedAt: "2026-10-19T00:00:00.000Z",
    };
    list.push(endpoint);
    return json(201, { endpoint, key: ENDPOINT_KEY });
  }
  const match = /^\/v1\/endpoints\/([^/]+)(\/rotate-key)?$/.exec(pathname);
  const target = list.find((e) => e.id === match?.[1]);
  if (!match || !target) return null;
  if (method === "POST" && match[2]) return json(200, { endpoint: target, key: ENDPOINT_KEY });
  if (method === "PUT") {
    if (b.rejectEndpointSave) {
      const status = b.rejectEndpointSave;
      b.rejectEndpointSave = undefined;
      return json(status, { code: "endpoint.slug_taken" });
    }
    Object.assign(target, input, { updatedAt: "2026-10-19T02:00:00.000Z" });
    return json(200, { endpoint: target });
  }
  if (method === "DELETE") {
    list.splice(list.indexOf(target), 1);
    return json(200, { endpoint: target });
  }
  return null;
}

export function installFetch(b: FakeBackend) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : (req?.url ?? ""),
      "http://localhost",
    );
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    let body: unknown;
    const raw = init?.body ?? (req ? await req.clone().text() : undefined);
    if (typeof raw === "string" && raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    b.calls.push({ method, path: url.pathname, body, search: url.search });
    switch (`${method} ${url.pathname}`) {
      case "GET /v1/me":
        if (b.meNetworkError) throw new TypeError("network down");
        return b.authed ? json(200, USER) : json(401, { code: "auth.unauthenticated" });
      case "GET /v1/setup/status":
        return json(200, { needsSetup: b.needsSetup, signupOpen: b.signupOpen });
      case "POST /api/auth/sign-in/email":
        if (b.signInStatus && b.signInStatus >= 400)
          return json(b.signInStatus, { code: "INVALID_EMAIL_OR_PASSWORD" });
        b.authed = true;
        return json(200, { user: USER });
      case "POST /api/auth/sign-up/email":
        if (b.signUpStatus && b.signUpStatus >= 400)
          return json(b.signUpStatus, { code: "auth.signup_disabled" });
        b.authed = true;
        b.needsSetup = false;
        return json(200, { user: USER });
      case "POST /api/auth/sign-out":
        b.authed = false;
        return json(200, { success: true });
      case "GET /v1/settings":
        return b.timeZone === undefined
          ? json(404, { code: "not_found" })
          : json(200, { timeZone: b.timeZone });
      case "GET /v1/settings/time-zones":
        return json(200, { timeZones: b.timeZones ?? ["Europe/Berlin", "UTC"] });
      case "PATCH /v1/settings": {
        if (b.timeZone === undefined) return json(404, { code: "not_found" });
        const next = (body as { timeZone: string }).timeZone;
        if (b.rejectSettings) return json(b.rejectSettings, { code: "request.invalid" });
        b.timeZone = next;
        return json(200, { timeZone: next });
      }
      case "GET /v1/diagnostics":
        return b.diagnostics === undefined
          ? json(404, { code: "not_found" })
          : json(200, b.diagnostics);
      default:
        return (
          rulesRoute(b, method, url.pathname, body) ??
          eventsRoute(b, method, url, body) ??
          integrationsRoute(b, method, url.pathname, body) ??
          keysRoute(b, method, url.pathname, body) ??
          endpointsRoute(b, method, url.pathname, body) ??
          json(404, { code: "not_found" })
        );
    }
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

export function mount(path: string, queryClient = new QueryClient()) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient, ...utils };
}

export const pathname = (r: { state: { location: { pathname: string } } }) =>
  r.state.location.pathname;

/** Types into labelled inputs (matched case-insensitively) and clicks the submit button. */
export async function fillAndSubmit(fields: Record<string, string>, button: RegExp) {
  for (const [label, value] of Object.entries(fields)) {
    const input = await screen.findByLabelText(new RegExp(label, "i"));
    fireEvent.change(input, { target: { value } });
  }
  fireEvent.click(await screen.findByRole("button", { name: button }));
}
