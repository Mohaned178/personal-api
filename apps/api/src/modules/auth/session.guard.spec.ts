import { Controller, Get, type INestApplication } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProblemFilter } from "../../platform/errors/problem.filter";
import type { Auth } from "./auth";
import { AUTH } from "./auth.tokens";
import { type AuthContext, CurrentAuth } from "./auth-context";
import { MeController } from "./me.controller";
import { SessionGuard, type SessionLookup } from "./session.guard";

// Compile-time proof that the real Better Auth instance satisfies what the guard relies on.
const authFitsGuard = (auth: Auth): SessionLookup => auth;
void authFitsGuard;

@Controller()
class UnguardedController {
  @Get("unguarded")
  read(@CurrentAuth("session") auth: AuthContext) {
    return auth;
  }
}

const alice = {
  session: { id: "session-a", token: "secret-token" },
  user: { id: "user-a", email: "alice@example.test", name: "Alice", emailVerified: false },
};

let app: INestApplication | undefined;

async function start(getSession: SessionLookup["api"]["getSession"]) {
  const moduleRef = await Test.createTestingModule({
    controllers: [MeController, UnguardedController],
    providers: [
      SessionGuard,
      { provide: AUTH, useValue: { api: { getSession } } },
      { provide: APP_FILTER, useClass: ProblemFilter },
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  return request(app.getHttpServer());
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("SessionGuard and GET /v1/me", () => {
  it("is 401 problem+json without a cookie, and does not even look up a session", async () => {
    const getSession = vi.fn(async () => alice);
    const res = await (await start(getSession)).get("/v1/me");
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 401, code: "auth.unauthenticated" });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("is 401 when Better Auth finds no session for the cookie", async () => {
    const res = await (await start(async () => null))
      .get("/v1/me")
      .set("Cookie", "better-auth.session_token=forged");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("auth.unauthenticated");
  });

  it("hands Better Auth only the Cookie header, never Authorization", async () => {
    const getSession = vi.fn(async (_input: { headers: Headers }) => null);
    await (await start(getSession))
      .get("/v1/me")
      .set("Authorization", "Bearer pa_read_notarealkey")
      .set("X-User-Id", "user-b");
    expect(getSession).not.toHaveBeenCalled();

    await (await start(getSession))
      .get("/v1/me")
      .set("Cookie", "better-auth.session_token=abc")
      .set("Authorization", "Bearer pa_read_notarealkey");
    const headers = getSession.mock.calls[0]?.[0].headers;
    expect([...(headers?.keys() ?? [])]).toEqual(["cookie"]);
  });

  it("returns only id, email and name of the session's user", async () => {
    const res = await (await start(async () => alice))
      .get("/v1/me")
      .query({ userId: "user-b" })
      .set("Cookie", "better-auth.session_token=abc");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "user-a", email: "alice@example.test", name: "Alice" });
  });

  it("CurrentAuth on a route without a guard fails closed with a 500", async () => {
    const res = await (await start(async () => alice))
      .get("/unguarded")
      .set("Cookie", "better-auth.session_token=abc");
    expect(res.status).toBe(500);
    expect(res.text).not.toContain("alice");
  });
});
