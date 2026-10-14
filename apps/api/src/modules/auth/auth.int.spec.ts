/**
 * M0-07 Dashboard auth, integration tests (Testcontainers; CI runs them, Docker is off locally).
 *
 * Contract these tests define (see also apps/api/test/auth.helpers.ts):
 *   POST /api/auth/sign-up/email  { email, password, name }   Better Auth
 *   POST /api/auth/sign-in/email  { email, password }         Better Auth
 *   POST /api/auth/sign-out                                   Better Auth
 *   GET  /v1/me                   session-guarded; 401 problem+json without a valid session
 *   ALLOW_SIGNUP=false: signups are refused with 403 problem+json, code `auth.signup_disabled`,
 *   unless no account exists yet (the first account can always sign up).
 */
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildAuthTestApp,
  captureOutput,
  getMe,
  meUser,
  newCredentials,
  resetAuthTables,
  type SessionCookie,
  sessionCookie,
  setCookieHeaders,
  signIn,
  signOut,
  signUp,
} from "../../../test/auth.helpers";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";

const PROBLEM_JSON = /^application\/problem\+json/;

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
}, 180_000);

afterAll(async () => {
  await testDb?.stop();
});

/** Signs a new account up, logs it in, and returns its credentials plus a valid session cookie. */
async function registerAndLogin(app: INestApplication, label: string) {
  const credentials = newCredentials(label);
  const up = await signUp(app, credentials);
  expect(up.status, "sign-up should succeed").toBe(200);
  const login = await signIn(app, credentials);
  expect(login.status, "sign-in should succeed").toBe(200);
  const cookie = sessionCookie(login) as SessionCookie;
  expect(cookie, "sign-in should set a session cookie").toBeDefined();
  return { credentials, cookie };
}

describe("dashboard auth with ALLOW_SIGNUP=true", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildAuthTestApp(testDb, { allowSignup: true });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetAuthTables(testDb.pool);
  });

  describe("full login flow", () => {
    it("signup -> login -> me returns the user -> logout -> me is 401", async () => {
      const credentials = newCredentials("flow");

      const up = await signUp(app, credentials);
      expect(up.status).toBe(200);

      const login = await signIn(app, credentials);
      expect(login.status).toBe(200);
      const cookie = sessionCookie(login);
      expect(cookie, "sign-in sets a session cookie").toBeDefined();

      const me = await getMe(app, cookie?.pair);
      expect(me.status).toBe(200);
      expect(meUser(me.body).email).toBe(credentials.email);
      expect(meUser(me.body).id).toBeTruthy();

      const out = await signOut(app, cookie?.pair);
      expect(out.status).toBe(200);

      const after = await getMe(app, cookie?.pair);
      expect(after.status).toBe(401);
    });

    it("logout revokes the session server-side: the old cookie stays dead if replayed", async () => {
      const { cookie } = await registerAndLogin(app, "replay");
      expect((await getMe(app, cookie.pair)).status).toBe(200);

      await signOut(app, cookie.pair).expect(200);

      // A client that kept the cookie (or an attacker who copied it) gets nothing.
      expect((await getMe(app, cookie.pair)).status).toBe(401);
      expect((await getMe(app, cookie.pair)).status).toBe(401);
    });

    it("logout clears the session cookie in the response", async () => {
      const { cookie } = await registerAndLogin(app, "clear");
      const out = await signOut(app, cookie.pair);
      expect(out.status).toBe(200);
      const cleared = setCookieHeaders(out).find((line) => line.startsWith(`${cookie.name}=`));
      expect(cleared, "sign-out sends a Set-Cookie for the session cookie").toBeDefined();
      expect(cleared).toMatch(/max-age=0|expires=thu, 01 jan 1970/i);
    });

    it("sign-out with a valid session cookie but a foreign Origin is 403 and keeps the session alive", async () => {
      const { cookie } = await registerAndLogin(app, "csrf");

      const res = await request(app.getHttpServer())
        .post("/api/auth/sign-out")
        .set("Origin", "https://evil.example")
        .set("Cookie", cookie.pair)
        .send({});

      expect(res.status).toBe(403);
      // The cross-site request did not revoke anything.
      expect((await getMe(app, cookie.pair)).status).toBe(200);
    });

    it("a second login creates a working session without invalidating the first", async () => {
      const { credentials, cookie } = await registerAndLogin(app, "twice");
      const second = sessionCookie(await signIn(app, credentials));
      expect(second).toBeDefined();
      expect((await getMe(app, second?.pair)).status).toBe(200);
      expect((await getMe(app, cookie.pair)).status).toBe(200);
    });
  });

  describe("session cookie attributes", () => {
    it("the session cookie is HttpOnly, SameSite=Lax and scoped to /", async () => {
      const credentials = newCredentials("cookie");
      await signUp(app, credentials);
      const login = await signIn(app, credentials);
      const cookie = sessionCookie(login);
      expect(cookie, "sign-in sets a session cookie").toBeDefined();
      expect(cookie?.header).toMatch(/;\s*httponly/i);
      expect(cookie?.header).toMatch(/;\s*samesite=lax/i);
      expect(cookie?.header).not.toMatch(/samesite=none/i);
      expect(cookie?.header).toMatch(/;\s*path=\//i);
    });

    it("every session cookie set by signup is also HttpOnly and SameSite=Lax", async () => {
      const up = await signUp(app, newCredentials("signupcookie"));
      expect(up.status).toBe(200);
      for (const line of setCookieHeaders(up)) {
        expect(line, "all cookies set on signup").toMatch(/;\s*httponly/i);
        expect(line, "all cookies set on signup").toMatch(/;\s*samesite=lax/i);
      }
    });
  });

  describe("guarded route", () => {
    it("GET /v1/me without a session returns 401 problem+json", async () => {
      const res = await getMe(app);
      expect(res.status).toBe(401);
      expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
      expect(res.body.status).toBe(401);
      expect(typeof res.body.code).toBe("string");
      expect(res.body.code.length).toBeGreaterThan(0);
    });

    it("GET /v1/me with a valid session returns 200", async () => {
      const { cookie } = await registerAndLogin(app, "guarded");
      expect((await getMe(app, cookie.pair)).status).toBe(200);
    });

    it("rejects a garbage session cookie with 401", async () => {
      const cookie = (await registerAndLogin(app, "garbage")).cookie;
      expect((await getMe(app, `${cookie.name}=not-a-real-session-token`)).status).toBe(401);
    });

    it("rejects a session cookie whose signature was tampered with, with 401", async () => {
      const { cookie } = await registerAndLogin(app, "tamper");
      const flipped = cookie.value.endsWith("A")
        ? `${cookie.value.slice(0, -1)}B`
        : `${cookie.value.slice(0, -1)}A`;
      expect((await getMe(app, `${cookie.name}=${flipped}`)).status).toBe(401);
    });

    it("rejects the raw session token without its signature, with 401", async () => {
      const { cookie } = await registerAndLogin(app, "unsigned");
      expect((await getMe(app, `${cookie.name}=${cookie.token}`)).status).toBe(401);
    });

    it("does not accept an API-key style bearer header as a dashboard session", async () => {
      const res = await getMe(app).set("Authorization", "Bearer pa_read_notarealkey");
      expect(res.status).toBe(401);
    });

    it("does not leak credentials or tokens in the me response", async () => {
      const { credentials, cookie } = await registerAndLogin(app, "leakcheck");
      const res = await getMe(app, cookie.pair);
      expect(res.status).toBe(200);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(credentials.password);
      expect(raw).not.toContain(cookie.token);
      expect(raw.toLowerCase()).not.toContain("password");
    });
  });

  describe("credential failures", () => {
    it("wrong password and unknown email are both 401 with identical bodies (no user enumeration)", async () => {
      const known = newCredentials("known");
      await signUp(app, known).expect(200);

      const wrongPassword = await signIn(app, {
        email: known.email,
        password: "Wrong-password-1!",
      });
      const unknownEmail = await signIn(app, {
        email: newCredentials("nobody").email,
        password: "Wrong-password-1!",
      });

      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(wrongPassword.headers["content-type"]).toBe(unknownEmail.headers["content-type"]);
      expect(wrongPassword.body).toEqual(unknownEmail.body);
    });

    it("failed logins set no session cookie and echo neither the email nor the password", async () => {
      const known = newCredentials("echo");
      await signUp(app, known).expect(200);
      const attempt = { email: known.email, password: "Wrong-password-2!" };

      const res = await signIn(app, attempt);
      expect(res.status).toBe(401);
      expect(sessionCookie(res)).toBeUndefined();
      expect(res.text).not.toContain(attempt.email);
      expect(res.text).not.toContain(attempt.password);
    });

    it("a failed login does not break the real account's ability to log in", async () => {
      const known = newCredentials("recover");
      await signUp(app, known).expect(200);
      await signIn(app, { email: known.email, password: "Wrong-password-3!" }).expect(401);
      expect((await signIn(app, known)).status).toBe(200);
    });
  });

  describe("malformed input", () => {
    it.each([
      ["missing password", { email: "a-missing@example.test", name: "x" }],
      ["missing email", { password: "Pw-valid-password-1", name: "x" }],
      ["malformed email", { email: "not-an-email", password: "Pw-valid-password-1", name: "x" }],
      ["too-short password", { email: "short@example.test", password: "a", name: "x" }],
      ["non-string password", { email: "num@example.test", password: 12345678, name: "x" }],
    ])("sign-up with %s is a 4xx client error and creates no account", async (_label, body) => {
      const res = await signUp(app, body as never);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);

      const email = (body as { email?: string }).email;
      const password = (body as { password?: unknown }).password;
      if (email && typeof password === "string") {
        expect((await signIn(app, { email, password })).status).toBeGreaterThanOrEqual(400);
      }
    });

    it("sign-in with an empty body is a 4xx client error, not a 500", async () => {
      const res = await signIn(app, {} as never);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    it("signing up the same email twice does not replace the original account's password", async () => {
      const original = newCredentials("dup");
      await signUp(app, original).expect(200);
      const second = await signUp(app, { ...original, password: "Pw-attacker-password-9" });
      expect(second.status).toBeGreaterThanOrEqual(400);
      expect((await signIn(app, original)).status).toBe(200);
      expect(
        (await signIn(app, { email: original.email, password: "Pw-attacker-password-9" })).status,
      ).toBe(401);
    });
  });

  describe("signups when ALLOW_SIGNUP=true", () => {
    it("allows the first account and further accounts", async () => {
      expect((await signUp(app, newCredentials("first"))).status).toBe(200);
      expect((await signUp(app, newCredentials("second"))).status).toBe(200);
      expect((await signUp(app, newCredentials("third"))).status).toBe(200);
    });
  });

  describe("tenant isolation of me", () => {
    it("user B's session returns user B, never user A", async () => {
      const a = await registerAndLogin(app, "tenant-a");
      const b = await registerAndLogin(app, "tenant-b");

      const meA = await getMe(app, a.cookie.pair);
      const meB = await getMe(app, b.cookie.pair);
      expect(meA.status).toBe(200);
      expect(meB.status).toBe(200);

      expect(meUser(meA.body).email).toBe(a.credentials.email);
      expect(meUser(meB.body).email).toBe(b.credentials.email);
      expect(meUser(meA.body).id).not.toBe(meUser(meB.body).id);
      expect(JSON.stringify(meB.body)).not.toContain(a.credentials.email);
      expect(JSON.stringify(meA.body)).not.toContain(b.credentials.email);
    });

    it("never takes the user from the request: id hints in query, header or body are ignored", async () => {
      const a = await registerAndLogin(app, "hint-a");
      const b = await registerAndLogin(app, "hint-b");
      const aId = meUser((await getMe(app, a.cookie.pair)).body).id as string;

      const res = await getMe(app, b.cookie.pair)
        .query({ userId: aId, user_id: aId })
        .set("X-User-Id", aId)
        .set("X-Forwarded-User", a.credentials.email);

      expect(res.status).toBe(200);
      expect(meUser(res.body).email).toBe(b.credentials.email);
      expect(meUser(res.body).id).not.toBe(aId);
    });

    it("logging out user A does not end user B's session", async () => {
      const a = await registerAndLogin(app, "iso-a");
      const b = await registerAndLogin(app, "iso-b");
      await signOut(app, a.cookie.pair).expect(200);
      expect((await getMe(app, a.cookie.pair)).status).toBe(401);
      expect((await getMe(app, b.cookie.pair)).status).toBe(200);
    });
  });

  describe("log hygiene (invariant 6)", () => {
    it("never writes passwords, emails or session tokens to captured log output", async () => {
      const credentials = newCredentials("logcheck");
      const capture = captureOutput();
      let output: string;
      let cookie: SessionCookie | undefined;
      try {
        await signUp(app, credentials);
        await signIn(app, { email: credentials.email, password: "Wrong-password-5!" });
        await signIn(app, { email: newCredentials("ghost").email, password: "Wrong-password-6!" });
        const login = await signIn(app, credentials);
        cookie = sessionCookie(login);
        await getMe(app, cookie?.pair);
        await getMe(app, `${cookie?.name}=forged-token-value`);
        await signOut(app, cookie?.pair);
        await getMe(app, cookie?.pair);
      } finally {
        output = capture.stop();
      }

      // Prove we really captured the app's request logs; otherwise the assertions below are vacuous.
      expect(output, "captured log output should include the request log lines").toContain(
        "statusCode",
      );
      expect(cookie, "sign-in should have produced a session cookie").toBeDefined();

      expect(output).not.toContain(credentials.password);
      expect(output).not.toContain("Wrong-password-5!");
      expect(output).not.toContain("Wrong-password-6!");
      expect(output).not.toContain(credentials.email);
      expect(output).not.toContain(cookie?.token as string);
      expect(output).not.toContain(cookie?.value as string);
      expect(output).not.toContain("forged-token-value");
    });
  });
});

describe("dashboard auth with ALLOW_SIGNUP=false", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildAuthTestApp(testDb, { allowSignup: false });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetAuthTables(testDb.pool);
  });

  it("the first account can always sign up, log in and read me", async () => {
    const first = newCredentials("owner");
    const up = await signUp(app, first);
    expect(up.status).toBe(200);

    const login = await signIn(app, first);
    expect(login.status).toBe(200);
    const me = await getMe(app, sessionCookie(login)?.pair);
    expect(me.status).toBe(200);
    expect(meUser(me.body).email).toBe(first.email);
  });

  it("blocks a later signup with 403 problem+json code auth.signup_disabled", async () => {
    await signUp(app, newCredentials("owner")).expect(200);

    const res = await signUp(app, newCredentials("latecomer"));
    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("auth.signup_disabled");
    expect(res.body.status).toBe(403);
  });

  it("a blocked signup creates no account and issues no session", async () => {
    await signUp(app, newCredentials("owner")).expect(200);
    const latecomer = newCredentials("latecomer");

    const res = await signUp(app, latecomer);
    expect(res.status).toBe(403);
    expect(sessionCookie(res)).toBeUndefined();

    // The refused account really does not exist.
    const login = await signIn(app, latecomer);
    expect(login.status).toBe(401);
    expect(sessionCookie(login)).toBeUndefined();
  });

  it("keeps blocking every further signup, not just the second", async () => {
    await signUp(app, newCredentials("owner")).expect(200);
    for (const label of ["b", "c", "d"]) {
      const res = await signUp(app, newCredentials(label));
      expect(res.status, `signup ${label}`).toBe(403);
      expect(res.body.code).toBe("auth.signup_disabled");
    }
  });

  it("the first account keeps working after later signups are refused", async () => {
    const owner = newCredentials("owner");
    await signUp(app, owner).expect(200);
    await signUp(app, newCredentials("latecomer")).expect(403);

    const login = await signIn(app, owner);
    expect(login.status).toBe(200);
    expect((await getMe(app, sessionCookie(login)?.pair)).status).toBe(200);
  });

  it("does not let a blocked signup overwrite or take over the first account's email", async () => {
    const owner = newCredentials("owner");
    await signUp(app, owner).expect(200);

    const takeover = await signUp(app, { ...owner, password: "Pw-attacker-password-9" });
    expect(takeover.status).toBeGreaterThanOrEqual(400);
    expect((await signIn(app, owner)).status).toBe(200);
    expect(
      (await signIn(app, { email: owner.email, password: "Pw-attacker-password-9" })).status,
    ).toBe(401);
  });

  it("with no accounts, simultaneous signups let exactly one through (bootstrap race)", async () => {
    const attempts = Array.from({ length: 5 }, (_, i) => newCredentials(`race${i}`));
    const results = await Promise.all(attempts.map((credentials) => signUp(app, credentials)));

    const accepted = results.filter((res) => res.status === 200);
    const refused = results.filter((res) => res.status !== 200);
    expect(accepted).toHaveLength(1);
    for (const res of refused) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("auth.signup_disabled");
    }
  });

  it("an empty database always admits the next signup, even after accounts were wiped", async () => {
    await signUp(app, newCredentials("owner")).expect(200);
    await signUp(app, newCredentials("blocked")).expect(403);

    await resetAuthTables(testDb.pool);

    expect((await signUp(app, newCredentials("fresh"))).status).toBe(200);
  });
});
