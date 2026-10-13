/**
 * Body parsing in the real AppModule (Testcontainers). The app runs with Nest's body parser off
 * (`bodyParser: false`, as in main.ts) because Better Auth reads the raw request stream, so
 * BodyParserModule must give ordinary controllers a parsed `req.body` while /api/auth/* keeps
 * working.
 */
import { Body, Controller, type INestApplication, Post } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authTestConfig,
  newCredentials,
  resetAuthTables,
  sessionCookie,
  signIn,
  signUp,
  TEST_ORIGIN,
} from "../../../test/auth.helpers";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { AppModule } from "../../app.module";
import { APP_CONFIG } from "../../config/config.module";

@Controller("test-body")
class EchoController {
  @Post()
  echo(@Body() body: unknown): { body: unknown } {
    return { body: body ?? null };
  }
}

let testDb: TestDatabase;
let app: INestApplication;

beforeAll(async () => {
  testDb = await startTestDatabase();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [EchoController],
  })
    .overrideProvider(APP_CONFIG)
    .useValue(authTestConfig(testDb, { allowSignup: true }))
    .compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  await app.init();
  await resetAuthTables(testDb.pool);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await testDb?.stop();
});

describe("body parsing with bodyParser: false", () => {
  it("gives a Nest controller the parsed JSON body", async () => {
    const res = await request(app.getHttpServer())
      .post("/test-body")
      .send({ a: 1, b: ["x"] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ body: { a: 1, b: ["x"] } });
  });

  it("gives a Nest controller the parsed urlencoded body", async () => {
    const res = await request(app.getHttpServer()).post("/test-body").type("form").send("a=1");
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ body: { a: "1" } });
  });

  it("refuses an oversized JSON body on a Nest route with 413 problem+json", async () => {
    const res = await request(app.getHttpServer())
      .post("/test-body")
      .send({ pad: "x".repeat(101 * 1024) });
    expect(res.status).toBe(413);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 413, code: "http.payload_too_large" });
  });

  it("answers malformed JSON on a Nest route with 400 problem+json", async () => {
    const res = await request(app.getHttpServer())
      .post("/test-body")
      .set("Content-Type", "application/json")
      .send('{"email": a@b.test}');
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.text).not.toContain("a@b.test");
  });

  it("refuses an oversized body on /api/auth/* with 413 problem+json", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/auth/sign-in/email")
      .set("Origin", TEST_ORIGIN)
      .send({ email: "big@b.test", pad: "x".repeat(101 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ status: 413, code: "http.payload_too_large" });
  });

  it("leaves /api/auth/* to Better Auth: sign-up and sign-in still work", async () => {
    const credentials = newCredentials("bodyparser");
    const up = await signUp(app, credentials);
    expect(up.status).toBe(200);
    const login = await signIn(app, credentials);
    expect(login.status).toBe(200);
    expect(sessionCookie(login)).toBeDefined();
  });
});
