import { once } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express, Request } from "express";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  AUTH_BODY_LIMIT_BYTES,
  AUTH_ROUTE,
  createAuthRequestHandler,
  isAuthPath,
  isBodyTooLarge,
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

  it("hands Better Auth the Express client address and drops a client-sent one", async () => {
    const seen: (string | string[] | undefined)[] = [];
    const record = vi.fn(async (incoming: IncomingMessage, res: ServerResponse) => {
      seen.push(incoming.headers["x-pa-client-ip"]);
      await okHandler(incoming, res);
    });
    const { app } = mount(admitAll, record);
    await request(app).post("/api/auth/sign-in/email").set("X-Pa-Client-Ip", "6.6.6.6").send({});
    // supertest connects over loopback; the spoofed value must not survive.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^(::ffff:)?127.0.0.1$|^::1$/);
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

/** Sends a POST whose body goes out with chunked transfer encoding (no Content-Length). */
async function postChunked(app: Express, path: string) {
  const server = http.createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<{ status: number | undefined; type: string; body: string }>(
      (resolve, reject) => {
        const outgoing = http.request(
          {
            host: "127.0.0.1",
            port,
            path,
            method: "POST",
            headers: { "content-type": "application/json" },
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              body += chunk;
            });
            res.on("end", () =>
              resolve({ status: res.statusCode, type: res.headers["content-type"] ?? "", body }),
            );
          },
        );
        outgoing.on("error", reject);
        outgoing.write('{"email":"chunked@b.test",');
        outgoing.end('"password":"x"}');
      },
    );
  } finally {
    server.close();
  }
}

describe("isBodyTooLarge", () => {
  const headers = (values: Record<string, string>) => ({ headers: values }) as Request;

  it("accepts no body and bodies up to the limit", () => {
    expect(isBodyTooLarge(headers({}))).toBe(false);
    expect(isBodyTooLarge(headers({ "content-length": "0" }))).toBe(false);
    expect(isBodyTooLarge(headers({ "content-length": String(AUTH_BODY_LIMIT_BYTES) }))).toBe(
      false,
    );
  });

  it("refuses bodies over the limit, of unknown length, or with a malformed length", () => {
    expect(isBodyTooLarge(headers({ "content-length": String(AUTH_BODY_LIMIT_BYTES + 1) }))).toBe(
      true,
    );
    expect(isBodyTooLarge(headers({ "transfer-encoding": "chunked" }))).toBe(true);
    expect(isBodyTooLarge(headers({ "content-length": "1e9" }))).toBe(true);
    expect(isBodyTooLarge(headers({ "content-length": "-1" }))).toBe(true);
    expect(isBodyTooLarge(headers({ "content-length": "abc" }))).toBe(true);
  });
});

describe("createAuthRequestHandler body limit", () => {
  it("refuses a body over 100 kb with 413 problem+json before Better Auth or the gate", async () => {
    const gate = { admit: vi.fn(admitAll.admit) };
    const { app, handle } = mount(gate);
    for (const path of ["/api/auth/sign-in/email", "/api/auth/sign-up/email"]) {
      const res = await request(app)
        .post(path)
        .send({ email: "big@b.test", pad: "x".repeat(AUTH_BODY_LIMIT_BYTES) });
      expect(res.status).toBe(413);
      expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
      expect(res.body).toMatchObject({ status: 413, code: "http.payload_too_large" });
      expect(res.text).not.toContain("big@b.test");
    }
    expect(handle).not.toHaveBeenCalled();
    expect(gate.admit).not.toHaveBeenCalled();
  });

  it("refuses a chunked body (no Content-Length) with 413 before Better Auth or the gate", async () => {
    const gate = { admit: vi.fn(admitAll.admit) };
    const { app, handle } = mount(gate);
    for (const path of ["/api/auth/sign-in/email", "/api/auth/sign-up/email"]) {
      const res = await postChunked(app, path);
      expect(res.status).toBe(413);
      expect(res.type).toMatch(/^application\/problem\+json/);
      expect(JSON.parse(res.body)).toMatchObject({ status: 413, code: "http.payload_too_large" });
    }
    expect(handle).not.toHaveBeenCalled();
    expect(gate.admit).not.toHaveBeenCalled();
  });

  it("passes a body of exactly the limit, and a request with no body, through", async () => {
    const { app, handle } = mount(admitAll);
    const prefix = '{"pad":"';
    const exact = `${prefix}${"x".repeat(AUTH_BODY_LIMIT_BYTES - prefix.length - 2)}"}`;
    expect(Buffer.byteLength(exact)).toBe(AUTH_BODY_LIMIT_BYTES);
    const full = await request(app)
      .post("/api/auth/sign-in/email")
      .set("Content-Type", "application/json")
      .send(exact);
    expect(full.status).toBe(200);
    const empty = await request(app).post("/api/auth/sign-out");
    expect(empty.status).toBe(200);
    expect(handle).toHaveBeenCalledTimes(2);
  });
});
