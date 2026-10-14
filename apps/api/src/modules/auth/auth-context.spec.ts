/**
 * M1-03 AuthContext union, CurrentAuth and the two guards (unit: the key service and Better Auth
 * are stubbed, no DB). The stubs are deliberately strict: the key service only accepts one exact
 * token, so a guard that reads the wrong place or forwards junk cannot pass by accident.
 *
 * Contract:
 *  - SessionGuard sets `req.auth = { kind: "session", userId, sessionId, user }`.
 *  - IngestKeyGuard reads only `Authorization: Bearer <token>` and asks
 *    `ApiKeysService.authenticateIngestKey(token)`; on success `req.auth` is exactly
 *    `{ kind: "ingest", userId, integrationId, keyId }`.
 *  - Every IngestKeyGuard failure is the same 401 problem+json, code `auth.invalid_key`.
 *  - `CurrentAuth("session" | "ingest")` fails closed (500) when auth is missing or the other kind.
 */
import type { INestApplication } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProbeController } from "../../../test/auth-probe.controller";
import { ProblemFilter } from "../../platform/errors/problem.filter";
import { ApiKeysService } from "../keys/api-keys.service";
import { IngestKeyGuard } from "../keys/ingest-key.guard";
import { AUTH } from "./auth.tokens";
import type { IngestAuthContext } from "./auth-context";
import { SessionGuard } from "./session.guard";

const PROBLEM_JSON = /^application\/problem\+json/;
const VALID_KEY = "pa_ing_validvalidvalidvalidvalidvalidvalidvalid123";
const INGEST_CTX: IngestAuthContext = {
  kind: "ingest",
  userId: "user-a",
  integrationId: "integration-a",
  keyId: "key-a",
};
const ALICE = {
  session: { id: "session-a" },
  user: { id: "user-a", email: "alice@example.test", name: "Alice" },
};

let app: INestApplication | undefined;

async function start() {
  const authenticateIngestKey = vi.fn(async (token: string | undefined) =>
    token === VALID_KEY ? INGEST_CTX : null,
  );
  const getSession = vi.fn(async (_input: { headers: Headers }) => ALICE);
  const moduleRef = await Test.createTestingModule({
    controllers: [AuthProbeController],
    providers: [
      SessionGuard,
      IngestKeyGuard,
      { provide: AUTH, useValue: { api: { getSession } } },
      { provide: ApiKeysService, useValue: { authenticateIngestKey } },
      { provide: APP_FILTER, useClass: ProblemFilter },
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  return { http: request(app.getHttpServer()), authenticateIngestKey, getSession };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("SessionGuard context", () => {
  it("sets a session AuthContext tagged kind 'session' with the session's user id", async () => {
    const { http } = await start();
    const res = await http.get("/probe/session").set("Cookie", "better-auth.session_token=abc");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: "session", userId: "user-a" });
  });
});

describe("IngestKeyGuard", () => {
  it("accepts Authorization: Bearer <key> and sets exactly {kind, userId, integrationId, keyId}", async () => {
    const { http, authenticateIngestKey } = await start();
    const res = await http.get("/probe/ingest").set("Authorization", `Bearer ${VALID_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(INGEST_CTX);
    expect(authenticateIngestKey).toHaveBeenCalledWith(VALID_KEY);
  });

  it("returns 401 problem+json auth.invalid_key when the key service rejects the token", async () => {
    const { http } = await start();
    const res = await http.get("/probe/ingest").set("Authorization", "Bearer pa_ing_unknown");
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body).toMatchObject({ status: 401, code: "auth.invalid_key" });
  });

  it("returns the same 401 when there is no Authorization header at all", async () => {
    const { http } = await start();
    const res = await http.get("/probe/ingest");
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("auth.invalid_key");
  });

  it("ignores cookies: a session cookie alone is 401 and never reaches Better Auth", async () => {
    const { http, getSession } = await start();
    const res = await http
      .get("/probe/ingest")
      .set("Cookie", "better-auth.session_token=abc; pa_ing=whatever");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("auth.invalid_key");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("ignores cookies even when a valid key is present: the key header alone decides", async () => {
    const { http, getSession } = await start();
    const res = await http
      .get("/probe/ingest")
      .set("Cookie", "better-auth.session_token=abc")
      .set("Authorization", `Bearer ${VALID_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("ingest");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("does not read the key from the query string, other headers, a cookie or the body", async () => {
    const { http } = await start();
    const attempts = [
      http.get("/probe/ingest").query({ api_key: VALID_KEY }),
      http.get("/probe/ingest").query({ access_token: VALID_KEY, key: VALID_KEY }),
      http.get("/probe/ingest").set("X-Api-Key", VALID_KEY),
      http.get("/probe/ingest").set("X-Authorization", `Bearer ${VALID_KEY}`),
      http.get("/probe/ingest").set("Cookie", `pa_ing=${VALID_KEY}`),
      http.post("/probe/ingest").send({ key: VALID_KEY, apiKey: VALID_KEY }),
    ];
    for (const attempt of attempts) {
      const res = await attempt;
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("auth.invalid_key");
    }
  });

  it("rejects a wrong scheme, an empty token or extra tokens without forwarding them", async () => {
    const { http, authenticateIngestKey } = await start();
    for (const header of [
      `Basic ${VALID_KEY}`,
      `Token ${VALID_KEY}`,
      VALID_KEY,
      "Bearer",
      "Bearer ",
      `Bearer ${VALID_KEY} extra`,
      `Bearer ${VALID_KEY},Bearer ${VALID_KEY}`,
    ]) {
      const res = await http.get("/probe/ingest").set("Authorization", header);
      expect(res.status, header).toBe(401);
      expect(res.body.code, header).toBe("auth.invalid_key");
    }
    expect(authenticateIngestKey).not.toHaveBeenCalledWith(VALID_KEY);
  });

  it("gives a pa_read_ key the same 401 as any other bad key", async () => {
    const { http } = await start();
    const res = await http
      .get("/probe/ingest")
      .set("Authorization", "Bearer pa_read_validvalidvalidvalidvalidvalidvalidvalid1");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("auth.invalid_key");
  });

  it("answers every failure with an identical problem body (no oracle)", async () => {
    const { http } = await start();
    const bodies: unknown[] = [];
    for (const header of [
      undefined,
      "Bearer pa_ing_unknown",
      "Bearer pa_read_something",
      "Bearer garbage",
      "Basic abc",
      "Bearer",
    ]) {
      const req = http.get("/probe/ingest");
      const res = await (header ? req.set("Authorization", header) : req);
      expect(res.status).toBe(401);
      bodies.push(res.body);
    }
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(JSON.stringify(bodies[0])).not.toContain("pa_");
  });

  it("takes userId and integrationId from the key, never from the query, body or headers", async () => {
    const { http } = await start();
    const res = await http
      .post("/probe/ingest?userId=user-b&integrationId=integration-b")
      .set("Authorization", `Bearer ${VALID_KEY}`)
      .set("X-User-Id", "user-b")
      .send({ userId: "user-b", integrationId: "integration-b", keyId: "key-b" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(INGEST_CTX);
  });
});

describe("the two guards are not interchangeable", () => {
  it("an ingest key cannot pass SessionGuard: 401 auth.unauthenticated, Better Auth never asked", async () => {
    const { http, getSession } = await start();
    const res = await http.get("/probe/session").set("Authorization", `Bearer ${VALID_KEY}`);
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("auth.unauthenticated");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("a session cookie cannot pass IngestKeyGuard: 401 auth.invalid_key", async () => {
    const { http } = await start();
    const res = await http.get("/probe/ingest").set("Cookie", "better-auth.session_token=abc");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("auth.invalid_key");
  });
});

describe("CurrentAuth fails closed on the wrong kind", () => {
  it("CurrentAuth('session') behind IngestKeyGuard is a 500 that leaks no context", async () => {
    const { http } = await start();
    // Control: the same key is accepted on a route that asks for the right kind.
    expect(
      (await http.get("/probe/ingest").set("Authorization", `Bearer ${VALID_KEY}`)).status,
    ).toBe(200);
    const res = await http
      .get("/probe/ingest-as-session")
      .set("Authorization", `Bearer ${VALID_KEY}`);
    expect(res.status).toBe(500);
    expect(res.text).not.toContain("integration-a");
    expect(res.text).not.toContain("key-a");
  });

  it("CurrentAuth('ingest') behind SessionGuard is a 500 that leaks no context", async () => {
    const { http } = await start();
    const res = await http
      .get("/probe/session-as-ingest")
      .set("Cookie", "better-auth.session_token=abc");
    expect(res.status).toBe(500);
    expect(res.text).not.toContain("alice@example.test");
  });

  it("CurrentAuth('ingest') on a route with no guard is a 500", async () => {
    const { http } = await start();
    // Control: the guarded twin of this route serves the same key.
    expect(
      (await http.get("/probe/ingest").set("Authorization", `Bearer ${VALID_KEY}`)).status,
    ).toBe(200);
    const res = await http
      .get("/probe/unguarded-ingest")
      .set("Authorization", `Bearer ${VALID_KEY}`);
    expect(res.status).toBe(500);
  });
});
