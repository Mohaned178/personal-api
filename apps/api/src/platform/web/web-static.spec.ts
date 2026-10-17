import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_FILTER } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { ProblemFilter } from "../errors/problem.filter";
import { HealthModule } from "../health/health.module";
import { mountWebApp } from "./web-static";

let app: NestExpressApplication;
let distDir: string | undefined;

/** Builds a fake dashboard output; `withBuild: false` simulates `vite build` never having run. */
async function start(withBuild: boolean): Promise<void> {
  distDir = mkdtempSync(join(tmpdir(), "pa-web-"));
  if (withBuild) {
    writeFileSync(join(distDir, "index.html"), "<!doctype html><title>dashboard</title>");
    mkdirSync(join(distDir, "assets"));
    writeFileSync(join(distDir, "assets", "app.js"), "console.log('dashboard')");
  }
  const moduleRef = await Test.createTestingModule({
    imports: [HealthModule],
    providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  mountWebApp(app, distDir);
  await app.init();
}

afterEach(async () => {
  await app.close();
  if (distDir) rmSync(distDir, { recursive: true, force: true });
  distDir = undefined;
});

describe("dashboard static hosting", () => {
  it("mounts and serves index.html at /", async () => {
    await start(true);
    const res = await request(app.getHttpServer()).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.text).toContain("<title>dashboard</title>");
  });

  it("serves real build files", async () => {
    await start(true);
    const res = await request(app.getHttpServer()).get("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.text).toContain("console.log");
  });

  it("falls back to index.html for client-side routes", async () => {
    await start(true);
    const res = await request(app.getHttpServer()).get("/events/42?filter=domain");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<title>dashboard</title>");
  });

  it("does not shadow the health endpoints", async () => {
    await start(true);
    for (const path of ["/healthz", "/readyz"]) {
      const res = await request(app.getHttpServer()).get(path);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^application\/json/);
      expect(res.text).not.toContain("<title>dashboard</title>");
    }
  });

  it("does not shadow API routes", async () => {
    await start(true);
    for (const path of ["/api", "/api/auth/session", "/v1/events"]) {
      const res = await request(app.getHttpServer()).get(path);
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
      expect(res.text).not.toContain("<title>dashboard</title>");
    }
  });

  it("does not answer non-GET requests", async () => {
    await start(true);
    const res = await request(app.getHttpServer()).post("/anything");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  });

  it("is a no-op when the build directory is missing", async () => {
    await start(false);
    const res = await request(app.getHttpServer()).get("/");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ code: "http.404" });
  });
});
