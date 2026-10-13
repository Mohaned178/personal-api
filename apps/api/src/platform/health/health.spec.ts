import type { INestApplication } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { ProblemFilter } from "../errors/problem.filter";
import { HealthModule } from "./health.module";
import { ReadinessRegistry } from "./readiness";

let app: INestApplication;

async function start(): Promise<ReadinessRegistry> {
  const moduleRef = await Test.createTestingModule({
    imports: [HealthModule],
    providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  return app.get(ReadinessRegistry);
}

afterEach(async () => {
  await app.close();
});

describe("health endpoints", () => {
  it("GET /healthz returns 200 ok", async () => {
    await start();
    const res = await request(app.getHttpServer()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /readyz returns 200 when no checks are registered", async () => {
    await start();
    const res = await request(app.getHttpServer()).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", checks: {} });
  });

  it("GET /readyz returns 200 when every check passes (sync and async)", async () => {
    const registry = await start();
    registry.register("db", () => {});
    registry.register("queue", async () => {});
    const res = await request(app.getHttpServer()).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ db: "up", queue: "up" });
  });

  it("GET /readyz returns 503 problem+json when a check fails, without leaking the error", async () => {
    const registry = await start();
    registry.register("db", () => {});
    registry.register("queue", async () => {
      throw new Error("connect ECONNREFUSED postgres://user:hunter2@host:5433/db");
    });
    const res = await request(app.getHttpServer()).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({
      status: 503,
      code: "health.not_ready",
      checks: { db: "up", queue: "down" },
    });
    expect(res.text).not.toContain("hunter2");
  });
});

describe("problem+json filter", () => {
  it("maps unknown routes to a stable code", async () => {
    await start();
    const res = await request(app.getHttpServer()).get("/nope");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 404, code: "http.404" });
  });
});
