/**
 * M7-03 hardening, end to end on the real app (Testcontainers; CI runs these): security headers,
 * CSRF on cookie-authenticated mutations, the per-key ingest limit and the login limit behind
 * TRUST_PROXY.
 */
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authTestConfig, TEST_ORIGIN } from "../../../test/auth.helpers";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { buildFixtureApp, type FixtureUser, seedTwoUsers } from "../../../test/two-user-fixture";
import { AppModule } from "../../app.module";
import { APP_CONFIG } from "../../config/config.module";
import { applyHttpHardening } from "../../platform/http/security";
import type { RateLimiter } from "../../platform/rate-limit/rate-limiter";
import { INGEST_RATE_LIMITER } from "../ingest/ingest.tokens";
import { INGEST_REQUESTS_PER_WINDOW } from "../ingest/ingest-rate-limit.guard";

let testDb: TestDatabase;
let app: INestApplication;
let a: FixtureUser;
let b: FixtureUser;
const extraApps: INestApplication[] = [];

beforeAll(async () => {
  testDb = await startTestDatabase();
  app = await buildFixtureApp(testDb);
  ({ a, b } = await seedTwoUsers(app, testDb));
}, 240_000);

afterAll(async () => {
  await app?.close();
  for (const extra of extraApps) await extra.close();
  await testDb?.stop();
});

beforeEach(() => {
  app.get<RateLimiter>(INGEST_RATE_LIMITER).reset();
});

const http = () => request(app.getHttpServer());

describe("security headers", () => {
  it.each(["/healthz", "/v1/me", "/no/such/route"])("%s carries helmet's headers", async (path) => {
    const res = await http().get(path);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["strict-transport-security"]).toBeDefined();
    expect(res.headers["x-powered-by"]).toBeUndefined();
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    // Would rewrite a plain-http self-hosted dashboard's requests to https.
    expect(csp).not.toContain("upgrade-insecure-requests");
  });
});

describe("CSRF on cookie mutations", () => {
  const foreign = "https://evil.example";

  it("refuses PATCH, POST and DELETE with a foreign Origin before doing anything", async () => {
    const patch = await http()
      .patch("/v1/settings")
      .set("Cookie", a.cookie)
      .set("Origin", foreign)
      .send({ timeZone: "Asia/Tokyo" });
    const post = await http()
      .post("/v1/keys")
      .set("Cookie", a.cookie)
      .set("Origin", foreign)
      .send({});
    const del = await http()
      .delete("/v1/events")
      .set("Cookie", a.cookie)
      .set("Origin", foreign)
      .send({ ids: ["00000000-0000-4000-8000-000000000000"] });
    for (const res of [patch, post, del]) {
      expect(res.status).toBe(403);
      expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
      expect(res.body).toMatchObject({ status: 403, code: "auth.csrf_origin_invalid" });
    }
    const settings = await http().get("/v1/settings").set("Cookie", a.cookie);
    expect(JSON.stringify(settings.body)).not.toContain("Asia/Tokyo");
  });

  it("refuses a cross-site browser request that sent no Origin", async () => {
    const res = await http()
      .patch("/v1/settings")
      .set("Cookie", a.cookie)
      .set("Sec-Fetch-Site", "cross-site")
      .send({ timeZone: "Asia/Tokyo" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("auth.csrf_origin_invalid");
  });

  it("lets the dashboard's own origin through", async () => {
    const res = await http()
      .patch("/v1/settings")
      .set("Cookie", a.cookie)
      .set("Origin", TEST_ORIGIN)
      .send({ timeZone: "Asia/Tokyo" });
    expect(res.status).toBe(200);
  });

  it("does not stand in the way of an ingest key, whatever the Origin", async () => {
    const res = await http()
      .post("/v1/ingest/heartbeat")
      .set("Authorization", `Bearer ${a.ingestKey}`)
      .set("Origin", "moz-extension://1234")
      .send({});
    expect(res.status).not.toBe(403);
  });
});

describe("ingest rate limit", () => {
  // An empty batch is a 400 after both guards, so it costs nothing but counts against the limit.
  const send = (key: string) =>
    http().post("/v1/ingest/events").set("Authorization", `Bearer ${key}`).send({ events: [] });

  it("limits one key with 429 ingest.rate_limited and Retry-After, and no other key", async () => {
    for (let i = 0; i < INGEST_REQUESTS_PER_WINDOW; i++) {
      expect((await send(a.ingestKey)).status).toBe(400);
    }
    const blocked = await send(a.ingestKey);
    expect(blocked.status).toBe(429);
    expect(blocked.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(blocked.body.code).toBe("ingest.rate_limited");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

    // Heartbeat shares the key's budget; user B's key has its own.
    const heartbeat = await http()
      .post("/v1/ingest/heartbeat")
      .set("Authorization", `Bearer ${a.ingestKey}`)
      .send({});
    expect(heartbeat.status).toBe(429);
    expect((await send(b.ingestKey)).status).toBe(400);
  });

  it("does not count requests with a bad key against anyone", async () => {
    for (let i = 0; i < INGEST_REQUESTS_PER_WINDOW + 5; i++) {
      expect((await send("pa_ing_not-a-real-key")).status).toBe(401);
    }
    expect((await send(a.ingestKey)).status).toBe(400);
  });
});

describe("login rate limit follows TRUST_PROXY", () => {
  async function productionApp(trustProxy: number): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue({
        ...authTestConfig(testDb, { allowSignup: true }),
        NODE_ENV: "production",
        TRUST_PROXY: trustProxy,
      })
      .compile();
    const prod = moduleRef.createNestApplication({ bodyParser: false });
    applyHttpHardening(prod, trustProxy);
    await prod.init();
    extraApps.push(prod);
    return prod;
  }

  const attempt = (target: INestApplication, forwardedFor: string) =>
    request(target.getHttpServer())
      .post("/api/auth/sign-in/email")
      .set("Origin", TEST_ORIGIN)
      .set("X-Forwarded-For", forwardedFor)
      .send({ email: "nobody@example.test", password: "wrong-password-123" });

  it("with no proxy, a forged X-Forwarded-For buys no extra attempts", async () => {
    const target = await productionApp(0);
    const statuses: number[] = [];
    for (let i = 1; i <= 5; i++) statuses.push((await attempt(target, `203.0.113.${i}`)).status);
    expect(statuses.slice(0, 3)).not.toContain(429);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });

  it("behind one proxy, each forwarded address has its own budget", async () => {
    const target = await productionApp(1);
    for (let i = 1; i <= 6; i++) {
      expect((await attempt(target, `198.51.100.${i}`)).status).not.toBe(429);
    }
    const same: number[] = [];
    for (let i = 0; i < 5; i++) same.push((await attempt(target, "192.0.2.9")).status);
    expect(same.slice(3)).toEqual([429, 429]);
  });
});
