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
  /** Retention policies for /v1/retention. Leave unset and those routes answer 404. */
  retention?: Array<{ scope: "source" | "type"; target: string; days: number; updatedAt: string }>;
  /** Focus session for /v1/focus (M9-06). Leave unset and those routes answer 404. */
  focus?: { endsAt: string; patterns: string[]; id: string } | null;
  /** Schedules for /v1/schedules (M9-06). Leave unset and those routes answer 404. */
  schedules?: Array<{
    id: string;
    name: string;
    patterns: string[];
    days: number[];
    start: string;
    end: string;
    enabled: boolean;
  }>;
  /** Daily limits for /v1/limits. Leave unset and those routes answer 404. */
  limits?: Array<{ id: string; pattern: string; minutes: number; strict: boolean }>;
  /** Time zone for /v1/settings. Leave unset and those routes answer 404. */
  timeZone?: string;
  /** Names for GET /v1/settings/time-zones (what the database accepts). */
  timeZones?: string[];
  /** Answer PATCH /v1/settings with this error status. */
  rejectSettings?: number;
  /** Suggestions for GET /v1/recommendations. Leave unset and that route answers 404. */
  recommendations?: unknown[];
  /** Aggregates for /v1/activity. Leave unset and those routes answer 404. */
  activity?: FakeActivity;
  calls: { method: string; path: string; body: unknown; search?: string }[];
}

export interface FakeActivity {
  days: { date: string; activeMs: number; pageVisits: number }[];
  /** Already sorted like the API (most active first); the route applies `limit`. */
  domains: { domain: string; activeMs: number; pageVisits: number }[];
  /** Cells for /v1/activity/hours. */
  hours?: { weekday: number; hour: number; activeMs: number }[];
  /** Newest first; /v1/activity/sessions pages them by `limit` with the index as the cursor. */
  sessions?: {
    id: string;
    domain: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
  }[];
  /** Answer for /v1/activity/site (zero totals when unset). */
  site?: Record<string, unknown>;
  /** Answer `/v1/activity/domains` differently for a window: matched on the `from` it is asked. */
  domainsByFrom?: Record<string, { domain: string; activeMs: number; pageVisits: number }[]>;
  /** When set, the activity routes wait for it before answering (the loading state). */
  hold?: Promise<void>;
}

async function activityRoute(b: FakeBackend, method: string, url: URL): Promise<Response | null> {
  const activity = b.activity;
  if (!activity || method !== "GET" || !url.pathname.startsWith("/v1/activity/")) return null;
  await activity.hold;
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (url.pathname === "/v1/activity/daily") {
    return json(200, { from, to, timeZone: b.timeZone ?? "UTC", days: activity.days });
  }
  if (url.pathname === "/v1/activity/domains") {
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const domains = activity.domainsByFrom?.[from] ?? activity.domains;
    return json(200, { from, to, domains: domains.slice(0, limit) });
  }
  if (url.pathname === "/v1/activity/hours") {
    return json(200, { from, to, timeZone: b.timeZone ?? "UTC", cells: activity.hours ?? [] });
  }
  if (url.pathname === "/v1/activity/sessions") {
    const all = activity.sessions ?? [];
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const start = Number(url.searchParams.get("cursor") ?? 0);
    const sessions = all.slice(start, start + limit);
    const next = start + limit < all.length ? String(start + limit) : null;
    return json(200, { from, to, sessions, nextCursor: next });
  }
  if (url.pathname === "/v1/activity/site") {
    const domain = url.searchParams.get("domain") ?? "";
    return json(200, {
      domain,
      from,
      to,
      timeZone: b.timeZone ?? "UTC",
      days: [],
      activeMs: 0,
      pageVisits: 0,
      sessions: 0,
      averageSessionMs: 0,
      longestSessionMs: 0,
      paths: [],
      ...activity.site,
    });
  }
  return null;
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

function retentionRoute(
  b: FakeBackend,
  method: string,
  pathname: string,
  body: unknown,
): Response | null {
  const list = b.retention;
  if (!list) return null;
  if (method === "GET" && pathname === "/v1/retention") {
    return json(200, { defaultDays: 90, policies: list });
  }
  const m = /^\/v1\/retention\/(source|type)\/([^/]+)$/.exec(pathname);
  if (!m) return null;
  const scope = m[1] as "source" | "type";
  const target = decodeURIComponent(m[2] as string);
  const at = list.findIndex((p) => p.scope === scope && p.target === target);
  if (method === "PUT") {
    const days = (body as { days: number }).days;
    const policy = { scope, target, days, updatedAt: "2026-10-19T00:00:00.000Z" };
    if (at === -1) list.push(policy);
    else list[at] = policy;
    return json(200, policy);
  }
  if (method === "DELETE") {
    if (at === -1) return json(404, { code: "retention.target_not_found" });
    list.splice(at, 1);
    return new Response(null, { status: 204 });
  }
  return null;
}

const FOCUS_ID = "0192f1c2-7c1e-7a3b-9f00-0000000000f1";

function blockingRoute(
  b: FakeBackend,
  method: string,
  pathname: string,
  body: unknown,
): Response | null {
  if (pathname === "/v1/focus" && b.focus !== undefined) {
    if (method === "GET") return json(200, { session: b.focus });
    if (method === "POST") {
      const start = body as { patterns: string[]; minutes: number };
      b.focus = {
        id: FOCUS_ID,
        patterns: start.patterns,
        endsAt: new Date(Date.now() + start.minutes * 60_000).toISOString(),
      };
      return json(201, { session: b.focus });
    }
    if (method === "DELETE") {
      b.focus = null;
      return new Response(null, { status: 204 });
    }
    return null;
  }
  const list = b.schedules;
  if (!list) return null;
  if (pathname === "/v1/schedules") {
    if (method === "GET") return json(200, { schedules: list });
    if (method === "POST") {
      const save = body as Omit<(typeof list)[number], "id">;
      const created = {
        id: `0192f1c2-7c1e-7a3b-9f00-${String(list.length + 1).padStart(12, "0")}`,
        ...save,
      };
      list.push(created);
      return json(201, created);
    }
    return null;
  }
  const m = /^\/v1\/schedules\/([^/]+)$/.exec(pathname);
  if (!m) return null;
  const at = list.findIndex((s) => s.id === m[1]);
  if (at === -1) return json(404, { code: "schedule.not_found" });
  if (method === "PUT") {
    const replaced = { id: m[1] as string, ...(body as object) } as (typeof list)[number];
    list[at] = replaced;
    return json(200, replaced);
  }
  if (method === "DELETE") {
    list.splice(at, 1);
    return new Response(null, { status: 204 });
  }
  return null;
}

function limitsRoute(
  b: FakeBackend,
  method: string,
  pathname: string,
  body: unknown,
): Response | null {
  const list = b.limits;
  if (!list) return null;
  if (pathname === "/v1/limits") {
    if (method === "GET") return json(200, { limits: list });
    if (method === "POST") {
      const save = body as { pattern: string; minutes: number; strict?: boolean };
      if (list.some((l) => l.pattern === save.pattern)) {
        return json(409, { code: "limit.pattern_taken" });
      }
      const created = {
        id: `0192f1c2-7c1e-7a3b-9f00-${String(list.length + 1).padStart(12, "0")}`,
        pattern: save.pattern,
        minutes: save.minutes,
        strict: save.strict ?? false,
      };
      list.push(created);
      return json(201, created);
    }
    return null;
  }
  const m = /^\/v1\/limits\/([^/]+)$/.exec(pathname);
  if (!m) return null;
  const at = list.findIndex((l) => l.id === m[1]);
  if (at === -1) return json(404, { code: "limit.not_found" });
  if (method === "PUT") {
    const save = body as { pattern: string; minutes: number; strict?: boolean };
    const replaced = { id: m[1] as string, ...save, strict: save.strict ?? false };
    list[at] = replaced;
    return json(200, replaced);
  }
  if (method === "DELETE") {
    list.splice(at, 1);
    return new Response(null, { status: 204 });
  }
  return null;
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
      case "GET /v1/recommendations":
        return b.recommendations === undefined
          ? json(404, { code: "not_found" })
          : json(200, {
              from: "2026-09-23T00:00:00.000Z",
              to: "2026-10-21T03:00:00.000Z",
              timeZone: b.timeZone ?? "UTC",
              recommendations: b.recommendations,
            });
      case "GET /v1/diagnostics":
        return b.diagnostics === undefined
          ? json(404, { code: "not_found" })
          : json(200, b.diagnostics);
      default:
        return (
          (await activityRoute(b, method, url)) ??
          retentionRoute(b, method, url.pathname, body) ??
          limitsRoute(b, method, url.pathname, body) ??
          blockingRoute(b, method, url.pathname, body) ??
          rulesRoute(b, method, url.pathname, body) ??
          eventsRoute(b, method, url, body) ??
          integrationsRoute(b, method, url.pathname, body) ??
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
