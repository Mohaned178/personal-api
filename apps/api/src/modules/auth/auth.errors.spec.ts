/**
 * Regression test (invariant 6): when the database fails, Better Auth must not print the raw
 * error (Drizzle's `Failed query: <sql> params: <email>`) to stdout/stderr, and the client must
 * get a bare 500 problem+json. Runs without Docker: the pool points at a closed local port.
 */
import { toNodeHandler } from "better-auth/node";
import express from "express";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { captureOutput, TEST_ORIGIN } from "../../../test/auth.helpers";
import { createDb } from "../../platform/db/db";
import { createAuth } from "./auth";
import { AUTH_ROUTE, createAuthRequestHandler, type SignupAdmission } from "./auth.http";

// Port 1 is never a Postgres server (and never 5432): every query fails to connect.
const pool = new Pool({
  connectionString: "postgres://nobody:nothing@127.0.0.1:1/none",
  connectionTimeoutMillis: 2000,
});
pool.on("error", () => {});

afterAll(async () => {
  await pool.end();
});

const admitAll: SignupAdmission = {
  admit: async (signup) => {
    await signup();
    return true;
  },
};

function app() {
  const auth = createAuth({
    config: {
      BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
      BETTER_AUTH_URL: TEST_ORIGIN,
    },
    db: createDb(pool),
    canCreateUser: async () => true,
  });
  const server = express();
  server.all(AUTH_ROUTE, createAuthRequestHandler(toNodeHandler(auth), admitAll));
  return server;
}

describe("Better Auth database failures", () => {
  it("answer 500 problem+json and never print the query, its params or the email", async () => {
    const email = "leak-check-7f3a@example.test";
    const password = "Pw-not-a-real-password-91c2";
    const output = captureOutput();
    let res: request.Response;
    try {
      res = await request(app())
        .post("/api/auth/sign-in/email")
        .set("Origin", TEST_ORIGIN)
        .send({ email, password });
    } finally {
      // Give any late writes (console, pino) a tick to land inside the capture.
      await new Promise((resolve) => setImmediate(resolve));
    }
    const printed = output.stop();

    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 500, code: "internal.error" });
    expect(res.body.detail).toBeUndefined();
    for (const secret of [email, "example.test", password, "Failed query", "params", "select"]) {
      expect(printed.toLowerCase(), `printed: ${secret}`).not.toContain(secret.toLowerCase());
      expect(res.text.toLowerCase(), `responded: ${secret}`).not.toContain(secret.toLowerCase());
    }
  }, 30_000);

  it("still answer Better Auth's own API errors normally (here a validation error)", async () => {
    const res = await request(app())
      .post("/api/auth/sign-in/email")
      .set("Origin", TEST_ORIGIN)
      .send({ email: "not-an-email", password: "x" });
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
  }, 30_000);
});
