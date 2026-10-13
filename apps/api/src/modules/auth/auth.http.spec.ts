import type { IncomingMessage, ServerResponse } from "node:http";
import type { Request } from "express";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  AUTH_ROUTE,
  createAuthRequestHandler,
  createBodyParser,
  isAuthPath,
  isSignUpPath,
  type SignupAdmission,
} from "./auth.http";

const req = (originalUrl: string) => ({ originalUrl, url: originalUrl }) as Request;

describe("isSignUpPath", () => {
  it.each([
    "/api/auth/sign-up/email",
    "/api/auth/sign-up/email/",
    "/api/auth/sign-up/email?callbackURL=/x",
    "/API/Auth/Sign-Up/Email",
    "/api/auth/sign%2Dup/email",
    "/api/auth/x/../sign-up/email",
    "/api/auth/sign-up/anything-else",
  ])("gates %s", (url) => {
    expect(isSignUpPath(req(url))).toBe(true);
  });

  it.each(["/api/auth/sign-in/email", "/api/auth/sign-out", "/api/auth/get-session", "/v1/me"])(
    "does not gate %s",
    (url) => {
      expect(isSignUpPath(req(url))).toBe(false);
    },
  );
});

describe("isAuthPath", () => {
  it("matches the auth base path and below, nothing else", () => {
    expect(isAuthPath(req("/api/auth"))).toBe(true);
    expect(isAuthPath(req("/api/auth/sign-in/email"))).toBe(true);
    expect(isAuthPath(req("/api/authx"))).toBe(false);
    expect(isAuthPath(req("/v1/me"))).toBe(false);
  });
});

/** An Express app with the auth route mounted like AuthModule does, over a fake Better Auth. */
function mount(gate: SignupAdmission, handle = vi.fn(okHandler)) {
  const app = express();
  app.all(AUTH_ROUTE, createAuthRequestHandler(handle, gate));
  return { app, handle };
}

async function okHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
}

const admitAll: SignupAdmission = {
  admit: async (signup) => {
    await signup();
    return true;
  },
};
const refuseAll: SignupAdmission = { admit: async () => false };

describe("createAuthRequestHandler", () => {
  it("passes non-signup auth requests straight to Better Auth", async () => {
    const gate = { admit: vi.fn(refuseAll.admit) };
    const { app, handle } = mount(gate);
    const res = await request(app).post("/api/auth/sign-in/email").send({});
    expect(res.status).toBe(200);
    expect(handle).toHaveBeenCalledOnce();
    expect(gate.admit).not.toHaveBeenCalled();
  });

  it("runs an admitted signup through Better Auth", async () => {
    const { app, handle } = mount(admitAll);
    const res = await request(app).post("/api/auth/sign-up/email").send({});
    expect(res.status).toBe(200);
    expect(handle).toHaveBeenCalledOnce();
  });

  it("answers a refused signup with 403 problem+json auth.signup_disabled", async () => {
    const { app, handle } = mount(refuseAll);
    const res = await request(app).post("/api/auth/sign-up/email").send({ email: "a@b.test" });
    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 403, code: "auth.signup_disabled" });
    expect(res.text).not.toContain("a@b.test");
    expect(handle).not.toHaveBeenCalled();
  });

  it("gates a signup URL in a non-canonical form too", async () => {
    const { app, handle } = mount(refuseAll);
    const res = await request(app).post("/API/auth/sign-up/email/").send({});
    expect(res.status).toBe(403);
    expect(handle).not.toHaveBeenCalled();
  });

  it("turns an unexpected failure into a 500 problem+json without its message", async () => {
    const failing = vi.fn(async () => {
      throw new Error("password authentication failed for hunter2");
    });
    const { app } = mount(admitAll, failing);
    const res = await request(app).post("/api/auth/sign-in/email").send({});
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body.code).toBe("internal.error");
    expect(res.text).not.toContain("hunter2");
  });
});

describe("createBodyParser", () => {
  function app() {
    const server = express();
    server.use(createBodyParser());
    server.post("/{*splat}", (request, response) => {
      response.json({ body: request.body ?? null, readable: request.readable });
    });
    return server;
  }

  it("parses JSON for ordinary routes", async () => {
    const res = await request(app()).post("/v1/things").send({ a: 1 });
    expect(res.body.body).toEqual({ a: 1 });
  });

  it("parses urlencoded forms for ordinary routes", async () => {
    const res = await request(app()).post("/v1/things").type("form").send("a=1");
    expect(res.body.body).toEqual({ a: "1" });
  });

  it("leaves the raw stream untouched for Better Auth routes", async () => {
    const res = await request(app()).post("/api/auth/sign-in/email").send({ a: 1 });
    expect(res.body).toEqual({ body: null, readable: true });
  });
});
