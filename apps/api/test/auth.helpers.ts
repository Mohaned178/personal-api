/**
 * Test helpers for the dashboard-auth integration tests (M0-07).
 *
 * All assumptions about HOW auth is wired into the Nest app live in this one file, so the
 * implementer can adapt the wiring (config key names, app options, table reset) without touching
 * the assertions in `src/modules/auth/auth.int.spec.ts`:
 *
 *  - The app is `AppModule` with `APP_CONFIG` overridden (like jobs.int.spec.ts does).
 *  - Config keys assumed: `ALLOW_SIGNUP` (boolean), `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`.
 *  - The Nest app is created with `bodyParser: false` (Better Auth needs the raw body).
 *  - Better Auth is mounted at `/api/auth/*`; `GET /v1/me` is the session-guarded route.
 *  - Auth POSTs carry an `Origin` header equal to `BETTER_AUTH_URL`, as a browser would send.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { APP_CONFIG } from "../src/config/config.module";
import type { TestDatabase } from "./postgres";

export const TEST_ORIGIN = "http://localhost:3000";

export interface AuthAppOptions {
  allowSignup: boolean;
}

/** The config the test app runs with. Adapt key names here if the implementation differs. */
export function authTestConfig(testDb: TestDatabase, options: AuthAppOptions) {
  return {
    NODE_ENV: "test",
    PORT: 0,
    LOG_LEVEL: "info",
    DATABASE_URL: testDb.url,
    ALLOW_SIGNUP: options.allowSignup,
    BETTER_AUTH_SECRET: `test-secret-${randomUUID()}${randomUUID()}`,
    BETTER_AUTH_URL: TEST_ORIGIN,
  };
}

/** Builds and initializes the real application against the Testcontainers database. */
export async function buildAuthTestApp(
  testDb: TestDatabase,
  options: AuthAppOptions,
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(authTestConfig(testDb, options))
    .compile();
  const app = moduleRef.createNestApplication({ bodyParser: false });
  await app.init();
  return app;
}

/**
 * Empties every table except `app_meta` (the Better Auth tables, whatever the schema names them),
 * so each test starts from "no accounts exist". The names come from information_schema only.
 */
export async function resetAuthTables(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> 'app_meta'`,
  );
  if (rows.length === 0) return;
  const list = rows.map((row) => `"${row.table_name}"`).join(", ");
  await pool.query(`truncate ${list} restart identity cascade`);
}

export interface Credentials {
  email: string;
  password: string;
  name: string;
}

export function newCredentials(label = "user"): Credentials {
  const id = randomUUID().replaceAll("-", "").slice(0, 12);
  return {
    email: `${label}-${id}@example.test`,
    password: `Pw-${randomUUID()}`,
    name: `Test ${label}`,
  };
}

type Agent = ReturnType<typeof request>;
const http = (app: INestApplication): Agent => request(app.getHttpServer());

export function signUp(app: INestApplication, credentials: Credentials) {
  return http(app).post("/api/auth/sign-up/email").set("Origin", TEST_ORIGIN).send(credentials);
}

export function signIn(
  app: INestApplication,
  credentials: Pick<Credentials, "email" | "password">,
) {
  return http(app)
    .post("/api/auth/sign-in/email")
    .set("Origin", TEST_ORIGIN)
    .send({ email: credentials.email, password: credentials.password });
}

export function signOut(app: INestApplication, cookie?: string) {
  const req = http(app).post("/api/auth/sign-out").set("Origin", TEST_ORIGIN).send({});
  return cookie ? req.set("Cookie", cookie) : req;
}

export function getMe(app: INestApplication, cookie?: string) {
  const req = http(app).get("/v1/me");
  return cookie ? req.set("Cookie", cookie) : req;
}

export function setCookieHeaders(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers["set-cookie"];
  if (Array.isArray(raw)) return raw.map(String);
  return typeof raw === "string" ? [raw] : [];
}

export interface SessionCookie {
  /** `name=value`, ready to send back in a `Cookie` header. */
  pair: string;
  name: string;
  value: string;
  /** The session token itself (the signed cookie value without its signature). */
  token: string;
  /** The full Set-Cookie line, for attribute checks. */
  header: string;
}

/** Finds the session cookie in a response, or undefined when the response sets none. */
export function sessionCookie(res: {
  headers: Record<string, unknown>;
}): SessionCookie | undefined {
  const header = setCookieHeaders(res).find((line) => /session_token=/i.test(line));
  if (!header) return undefined;
  const pair = header.split(";")[0] ?? "";
  const eq = pair.indexOf("=");
  const name = pair.slice(0, eq);
  const value = pair.slice(eq + 1);
  if (value === "") return undefined; // a cleared cookie is not a session
  const token = decodeURIComponent(value).split(".")[0] ?? "";
  return { pair, name, value, token, header };
}

/** Accepts either `{ id, email }` or `{ user: { id, email } }` as the shape of `GET /v1/me`. */
export function meUser(body: unknown): { id: string | undefined; email: string | undefined } {
  const record = (body ?? {}) as Record<string, unknown>;
  const user = (record.user ?? record) as Record<string, unknown>;
  return {
    id: typeof user.id === "string" ? user.id : undefined,
    email: typeof user.email === "string" ? user.email : undefined,
  };
}

/**
 * Records everything the process writes to stdout/stderr (including pino's direct fd writes and
 * console.*), while still passing it through. Used to prove secrets never reach log output.
 */
export function captureOutput(): { stop: () => string } {
  const chunks: string[] = [];
  const text = (value: unknown): string =>
    typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";

  const restorers: Array<() => void> = [];
  const wrap = (target: object, key: string, pick: (args: unknown[]) => unknown) => {
    const record = target as Record<string, (...args: unknown[]) => unknown>;
    const original = record[key];
    if (typeof original !== "function") return;
    record[key] = function (this: unknown, ...args: unknown[]) {
      const captured = pick(args);
      if (captured !== undefined) chunks.push(text(captured));
      return original.apply(this, args);
    };
    restorers.push(() => {
      record[key] = original;
    });
  };

  const fdWrite = (args: unknown[]) => (args[0] === 1 || args[0] === 2 ? args[1] : undefined);
  wrap(fs, "writeSync", fdWrite);
  wrap(fs, "write", fdWrite);
  wrap(process.stdout, "write", (args) => args[0]);
  wrap(process.stderr, "write", (args) => args[0]);
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    wrap(console, level, (args) =>
      args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
    );
  }

  return {
    stop: () => {
      for (const restore of restorers.reverse()) restore();
      return chunks.join("\n");
    },
  };
}
