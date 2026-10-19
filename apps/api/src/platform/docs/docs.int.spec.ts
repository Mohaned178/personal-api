/**
 * M5-07: the OpenAPI document generated from the real AppModule, with the same mount as main.ts
 * (Testcontainers; CI runs these, Docker may be off locally). Booting the whole module also proves
 * that every route's DTO schema converts to JSON Schema: a schema that cannot would throw here.
 */
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authTestConfig } from "../../../test/auth.helpers";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { AppModule } from "../../app.module";
import { APP_CONFIG } from "../../config/config.module";
import { mountOpenApi } from "./openapi";

let testDb: TestDatabase;
let app: INestApplication;

beforeAll(async () => {
  testDb = await startTestDatabase();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(authTestConfig(testDb, { allowSignup: true }))
    .compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  mountOpenApi(app);
  await app.init();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await testDb?.stop();
});

describe("OpenAPI document from the real application", () => {
  it("lists the platform routes with their request shapes", async () => {
    const res = await request(app.getHttpServer()).get("/docs/json");
    expect(res.status).toBe(200);
    const paths = Object.keys(res.body.paths);
    for (const path of ["/v1/events", "/v1/me/{slug}", "/v1/ingest/events", "/v1/endpoints"]) {
      expect(paths, path).toContain(path);
    }
  });

  it("serves the UI at /docs", async () => {
    const res = await request(app.getHttpServer()).get("/docs");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
  });
});
