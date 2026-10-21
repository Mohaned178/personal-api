/**
 * M7-02 route-table suite. The route table is what Nest actually registers: every controller
 * handler, with the auth class read from its guard metadata (not from its name or path). Then:
 *
 *  1. The table is deny-by-default: the routes with no auth guard are exactly an explicit
 *     allowlist, and each route's guard class equals the one written down in CLASS_OF, so a
 *     dropped or swapped guard fails here by name.
 *  2. For every route, every kind of credential (none, a session, a signed-out session, ingest,
 *     a former read key, revoked keys, bearers that are not keys at all) gets exactly the
 *     answer its guard class promises. The keys are real and stored, so "wrong kind" is tested
 *     for real keys, not for keys that merely do not exist.
 *  3. Cross-tenant access stays in cross-tenant-sweep.int.spec.ts (it needs a seeded resource per
 *     route); the last block ties the two tables together so a route cannot be in one and not the
 *     other.
 *
 * Surfaces that are not Nest controllers are outside the table and public by design: Better
 * Auth's `/api/auth/*` (sign-up, sign-in, sign-out, session; its own checks and the signup
 * gate), `/docs` (request shapes only, ADR 0001 deviation 6) and the dashboard's static files.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RequestMethod, type Type } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ModulesContainer } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createViaRoute, revokeViaRoute, tenantState } from "../../../test/adversarial-helpers";
import { getMe, sessionCookie, signIn, signOut } from "../../../test/auth.helpers";
import { AuthProbeController } from "../../../test/auth-probe.controller";
import { FORMER_READ_KEY } from "../../../test/former-read-key";
import { type IngestHarness, PROBLEM_JSON, startIngestHarness } from "../../../test/ingest-helpers";
import { createExtension, issueCode } from "../../../test/pairing-helpers";
import type { RateLimiter } from "../../platform/rate-limit/rate-limiter";
import { ACCOUNT_RATE_LIMITER } from "../account/account.constants";
import { IngestKeyGuard } from "../keys/ingest-key.guard";
import { PAIRING_RATE_LIMITER } from "../pairing/pairing.tokens";
import { SessionGuard } from "./session.guard";

type AuthClass = "public" | "session" | "ingest";

const AUTH_GUARDS = new Map<unknown, AuthClass>([
  [SessionGuard, "session"],
  [IngestKeyGuard, "ingest"],
]);

/** Written down on purpose: the class every route is meant to have. */
const CLASS_OF: Record<string, AuthClass> = {};
function declare(authClass: AuthClass, routes: string[]) {
  for (const route of routes) CLASS_OF[route] = authClass;
}
declare("public", [
  "GET /healthz",
  "GET /readyz",
  "GET /v1/setup/status",
  // The pairing code is the credential, and the route is rate limited.
  "POST /v1/pair",
]);
declare("ingest", ["POST /v1/ingest/events", "POST /v1/ingest/heartbeat", "GET /v1/ingest/config"]);
declare("session", [
  "GET /v1/events",
  "GET /v1/activity/daily",
  "GET /v1/activity/domains",
  "GET /v1/me",
  "POST /v1/integrations",
  "GET /v1/integrations",
  "GET /v1/integrations/:id",
  "PATCH /v1/integrations/:id",
  "POST /v1/integrations/:id/revoke",
  "POST /v1/integrations/:id/pairing-code",
  "DELETE /v1/integrations/:id/data",
  "GET /v1/events/:id",
  "DELETE /v1/events",
  "GET /v1/events/deletions/:id",
  "GET /v1/diagnostics",
  "GET /v1/rules",
  "POST /v1/rules",
  "POST /v1/rules/test",
  "GET /v1/rules/:id",
  "PUT /v1/rules/:id",
  "DELETE /v1/rules/:id",
  "GET /v1/settings",
  "GET /v1/settings/time-zones",
  "PATCH /v1/settings",
  "DELETE /v1/account",
  "POST /v1/exports",
  "GET /v1/exports",
  "GET /v1/exports/:id",
  "GET /v1/exports/:id/download",
  "GET /v1/exports/:id/manifest",
  "GET /v1/retention",
  "PUT /v1/retention/:scope/:target",
  "DELETE /v1/retention/:scope/:target",
]);

interface RouteEntry {
  route: string;
  method: string;
  path: string;
  authClass: AuthClass;
}

/** Every controller route Nest registered, with its auth class taken from guard metadata. */
function routeTable(h: IngestHarness): RouteEntry[] {
  const entries: RouteEntry[] = [];
  for (const module of h.app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as Type | null;
      // The test-only probe routes are not part of the application.
      if (!controller || controller === AuthProbeController) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? "");
      const classGuards = (Reflect.getMetadata(GUARDS_METADATA, controller) ?? []) as unknown[];
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (typeof handler !== "function") continue;
        const methodId = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (methodId === undefined) continue;
        const sub = String(Reflect.getMetadata(PATH_METADATA, handler) ?? "");
        const path = `/${[base, sub].filter(Boolean).join("/")}`
          .replaceAll(/\/+/g, "/")
          .replace(/(.)\/$/, "$1");
        const method = RequestMethod[methodId] as string;
        const handlerGuards = (Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[];
        const found = new Set<AuthClass>();
        for (const guard of [...classGuards, ...handlerGuards]) {
          const authClass = AUTH_GUARDS.get(guard);
          if (authClass) found.add(authClass);
        }
        if (found.size > 1) {
          throw new Error(`${method} ${path} stacks several auth guards: ${[...found].join(", ")}`);
        }
        entries.push({
          route: `${method} ${path}`,
          method,
          path,
          authClass: [...found][0] ?? "public",
        });
      }
    }
  }
  return entries.sort((a, b) => a.route.localeCompare(b.route));
}

type Kind =
  | "none"
  | "session"
  | "signed-out-session"
  | "ingest"
  | "revoked-ingest"
  | "former-read"
  | "garbage-bearer"
  | "session-token-bearer"
  | "pairing-code-bearer";

interface Credential {
  kind: Kind;
  cookie?: string | undefined;
  bearer?: string | undefined;
}

let h: IngestHarness;
let credentials: Credential[];
let table: RouteEntry[];

const http = () => request(h.app.getHttpServer());
type Req = ReturnType<ReturnType<typeof http>["get"]>;

/** The one place a credential is put on a request. */
function applyCredential(req: Req, credential: Credential): Req {
  let out = req;
  if (credential.cookie) out = out.set("Cookie", credential.cookie);
  if (credential.bearer) out = out.set("Authorization", `Bearer ${credential.bearer}`);
  return out;
}

const MISSING_ID = "0192f1c2-7c1e-7a3b-9f00-000000000000";
const PARAMS: Record<string, string> = {
  ":id": MISSING_ID,
  ":scope": "type",
  ":target": "browser.page_visited",
};

/**
 * A strict-schema body no route accepts, so a request that gets past its guard ends in a 400 (or a
 * 404 for the made-up id) and never changes anything.
 */
const PROBE_BODY = { probe: "route-table-suite" };

function send(entry: RouteEntry, credential: Credential) {
  let path = entry.path;
  for (const [name, value] of Object.entries(PARAMS)) path = path.replace(name, value);
  const agent = http();
  const call = {
    GET: () => agent.get(path),
    POST: () => agent.post(path),
    PUT: () => agent.put(path),
    PATCH: () => agent.patch(path),
    DELETE: () => agent.delete(path),
  }[entry.method];
  if (!call) throw new Error(`unexpected method ${entry.method}`);
  const req = applyCredential(call(), credential);
  return entry.method === "GET" ? req : req.send(PROBE_BODY);
}

const UNAUTHENTICATED = { status: 401, code: "auth.unauthenticated" };
const INVALID_KEY = { status: 401, code: "auth.invalid_key" };

type Expectation = "passes-guard" | { status: number; code: string };

function expectedFor(entry: RouteEntry, credential: Credential): Expectation {
  const { kind } = credential;
  switch (entry.authClass) {
    case "public":
      return "passes-guard";
    case "session":
      return kind === "session" ? "passes-guard" : UNAUTHENTICATED;
    case "ingest":
      return kind === "ingest" ? "passes-guard" : INVALID_KEY;
  }
}

function refusalOf(res: Awaited<ReturnType<typeof send>>) {
  return { status: res.status, code: res.body?.code as string | undefined };
}

/** Whether the guard let the request through: not a 401, and no auth.* 403. */
function isAuthRefusal(res: Awaited<ReturnType<typeof send>>): boolean {
  const { status, code } = refusalOf(res);
  return status === 401 || (status === 403 && String(code).startsWith("auth."));
}

beforeAll(async () => {
  h = await startIngestHarness();
  table = routeTable(h);
  credentials = await buildCredentials();
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

/** One real credential of every kind, all belonging to user A. */
async function buildCredentials(): Promise<Credential[]> {
  const revokedIngest = await createViaRoute(h.app, h.a, "to be revoked");
  expect((await revokeViaRoute(h.app, h.a, revokedIngest.integrationId)).status).toBe(200);

  // A second session of A, signed out again: its cookie must be worthless.
  const login = await signIn(h.app, h.a.credentials);
  const second = sessionCookie(login);
  expect(second).toBeDefined();
  expect((await signOut(h.app, second?.pair)).status).toBe(200);
  expect((await getMe(h.app, second?.pair)).status).toBe(401);

  const extension = await createExtension(h.app, h.a, "route table extension");
  const { pairingCode } = await issueCode(h.app, h.a, extension);
  const sessionToken = decodeURIComponent(h.a.cookie.split("=")[1] ?? "").split(".")[0] ?? "";

  return [
    { kind: "none" },
    { kind: "session", cookie: h.a.cookie },
    { kind: "signed-out-session", cookie: second?.pair },
    { kind: "ingest", bearer: h.a.ingestKey },
    { kind: "revoked-ingest", bearer: revokedIngest.key },
    // Read keys were removed in M9-01: a key of that shape is just an unknown bearer.
    { kind: "former-read", bearer: FORMER_READ_KEY },
    { kind: "garbage-bearer", bearer: randomUUID() },
    { kind: "session-token-bearer", bearer: sessionToken },
    { kind: "pairing-code-bearer", bearer: pairingCode },
  ];
}

describe("the route table is deny by default", () => {
  it("has no route without an auth guard except the explicit public allowlist", () => {
    const open = table.filter((r) => r.authClass === "public").map((r) => r.route);
    const allowed = Object.entries(CLASS_OF)
      .filter(([, authClass]) => authClass === "public")
      .map(([route]) => route);
    expect(open.sort()).toEqual(allowed.sort());
  });

  it("gives every registered route the auth class written down for it, and no other", () => {
    const actual = Object.fromEntries(table.map((r) => [r.route, r.authClass]));
    expect(actual).toEqual(CLASS_OF);
  });
});

describe("every route answers every credential as its guard class promises", () => {
  it("has a table to test", () => {
    expect(table.length).toBe(Object.keys(CLASS_OF).length);
  });

  it.each(Object.keys(CLASS_OF).sort())("%s", async (route) => {
    const entry = table.find((r) => r.route === route);
    expect(entry, `${route} is not registered`).toBeDefined();
    // The declared class, not the one read from metadata: the answers are what is checked, so a
    // guard that is missing or swapped fails on behavior as well as in the registration tests.
    const target: RouteEntry = {
      ...(entry as RouteEntry),
      authClass: CLASS_OF[route] as AuthClass,
    };
    h.app.get<RateLimiter>(PAIRING_RATE_LIMITER).reset();
    h.app.get<RateLimiter>(ACCOUNT_RATE_LIMITER).reset();

    const before = [await state(h.a.userId), await state(h.b.userId)];
    const refused: Array<{ kind: Kind; res: Awaited<ReturnType<typeof send>> }> = [];
    const publicAnswers: Array<ReturnType<typeof refusalOf>> = [];

    for (const credential of credentials) {
      const expected = expectedFor(target, credential);
      // Only the refused requests run here: an allowed one may change state, and is sent below.
      if (expected === "passes-guard" && target.authClass !== "public") continue;
      // Each public request is a first request from a fresh client, so the throttle never answers.
      h.app.get<RateLimiter>(PAIRING_RATE_LIMITER).reset();
      const res = await send(target, credential);
      if (target.authClass === "public") {
        publicAnswers.push(refusalOf(res));
        continue;
      }
      expect(refusalOf(res), `${route} with ${credential.kind}`).toEqual(expected);
      expect(String(res.headers["content-type"]), `${route} with ${credential.kind}`).toMatch(
        PROBLEM_JSON,
      );
      refused.push({ kind: credential.kind, res });
    }

    // Refused requests change nothing for either tenant.
    expect([await state(h.a.userId), await state(h.b.userId)]).toEqual(before);

    // Which wrong credential was sent is never visible: all the bearers a class refuses get the
    // same body, and a valid key of the wrong kind looks like a key that does not exist.
    const bodies = new Set(refused.filter((r) => r.kind !== "none").map((r) => bodyOf(r.res)));
    expect(bodies.size, `${route} answers differently by credential kind`).toBeLessThanOrEqual(1);

    if (target.authClass === "public") {
      // No credential changes what a public route says.
      expect(publicAnswers.every((a) => a.status === publicAnswers[0]?.status)).toBe(true);
      expect(publicAnswers.some((a) => a.status === 401 || a.status === 403)).toBe(false);
      return;
    }

    // The positive control: the credential the class asks for is let past the guard, and the probe
    // never mutates (a made-up id or a body no schema accepts).
    const allowed = credentials.filter((c) => expectedFor(target, c) === "passes-guard");
    expect(allowed.length, `${route} has no credential that passes`).toBeGreaterThan(0);
    for (const credential of allowed) {
      const res = await send(target, credential);
      expect(
        isAuthRefusal(res),
        `${route} refused ${credential.kind}: ${JSON.stringify(res.body)}`,
      ).toBe(false);
      if (target.method !== "GET") {
        expect(
          res.status,
          `${route} with ${credential.kind} must not succeed on a probe`,
        ).toBeGreaterThanOrEqual(400);
      }
    }
  });
});

describe("the route table and the cross-tenant sweep list the same /v1 routes", () => {
  it("has a cross-tenant row for every /v1 route, and no row for a route that is gone", () => {
    const sweep = readFileSync(
      join(__dirname, "../integrations/cross-tenant-sweep.int.spec.ts"),
      "utf8",
    );
    const rows = [...sweep.matchAll(/^\s+route: "([A-Z]+ \/v1\/[^"]+)",$/gm)].map((m) => m[1]);
    const registered = table.filter((r) => r.path.startsWith("/v1/")).map((r) => r.route);
    expect([...new Set(rows)].sort()).toEqual(registered.sort());
  });
});

function bodyOf(res: Awaited<ReturnType<typeof send>>): string {
  return JSON.stringify({ status: res.status, code: res.body?.code, title: res.body?.title });
}

/** Everything of one tenant, minus the key usage timestamp that a valid key bumps by design. */
async function state(userId: string) {
  const snapshot = await tenantState(h.testDb.pool, userId);
  snapshot.apiKeys = (snapshot.apiKeys as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    last_used_at: null,
  }));
  return snapshot;
}
