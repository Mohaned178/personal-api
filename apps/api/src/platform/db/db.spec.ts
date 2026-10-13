import type { INestApplication } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProblemFilter } from "../errors/problem.filter";
import { HealthModule } from "../health/health.module";
import { DbModule } from "./db.module";
import { checkDb } from "./db.readiness";
import { PG_POOL } from "./db.tokens";

describe("checkDb", () => {
  it("resolves when SELECT 1 succeeds", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] });
    await expect(checkDb({ query })).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith("SELECT 1");
  });

  it("rejects when the query fails", async () => {
    const query = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(checkDb({ query })).rejects.toThrow();
  });

  it("rejects when the query hangs past the timeout", async () => {
    const query = vi.fn().mockReturnValue(new Promise(() => {}));
    await expect(checkDb({ query }, 20)).rejects.toThrow(/timeout/);
  });
});

describe("db readiness via /readyz", () => {
  let app: INestApplication | undefined;
  const pool = { query: vi.fn(), end: vi.fn().mockResolvedValue(undefined), on: vi.fn() };

  async function start(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [HealthModule, DbModule],
      providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return app;
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.clearAllMocks();
  });

  it("is 200 with the db check up when the pool answers", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request((await start()).getHttpServer()).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ db: "up" });
  });

  it("is 503 without leaking the error when the pool fails", async () => {
    pool.query.mockRejectedValue(new Error("password authentication failed for hunter2"));
    const res = await request((await start()).getHttpServer()).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "health.not_ready", checks: { db: "down" } });
    expect(res.text).not.toContain("hunter2");
  });

  it("closes the pool on shutdown", async () => {
    const running = await start();
    await running.close();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
