import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Body, Controller, Post } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { createZodDto } from "nestjs-zod";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { mountWebApp } from "../web/web-static";
import { mountOpenApi } from "./openapi";

class SampleDto extends createZodDto(z.object({ slug: z.string().min(1) })) {}

@Controller("sample")
class SampleController {
  @Post()
  create(@Body() body: SampleDto): SampleDto {
    return body;
  }
}

let app: NestExpressApplication;
let distDir: string | undefined;

/** Mounts the docs first and the dashboard second, the same order as main.ts. */
async function start(): Promise<void> {
  distDir = mkdtempSync(join(tmpdir(), "pa-docs-"));
  writeFileSync(join(distDir, "index.html"), "<!doctype html><title>dashboard</title>");
  const moduleRef = await Test.createTestingModule({
    controllers: [SampleController],
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  mountOpenApi(app);
  mountWebApp(app, distDir);
  await app.init();
}

afterEach(async () => {
  await app?.close();
  if (distDir) rmSync(distDir, { recursive: true, force: true });
  distDir = undefined;
});

describe("OpenAPI at /docs", () => {
  it("serves the JSON document with the Zod DTO as the request body schema", async () => {
    await start();
    const res = await request(app.getHttpServer()).get("/docs/json");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.body.openapi).toMatch(/^3\./);
    const schemaRef = res.body.paths["/sample"].post.requestBody.content["application/json"].schema;
    const name = String(schemaRef.$ref).split("/").pop() ?? "";
    expect(res.body.components.schemas[name].properties).toHaveProperty("slug");
  });

  it("serves the YAML document under the same prefix", async () => {
    await start();
    const res = await request(app.getHttpServer()).get("/docs/yaml");
    expect(res.status).toBe(200);
    expect(res.text).toContain("openapi:");
  });

  it("serves the UI at /docs as HTML", async () => {
    await start();
    const res = await request(app.getHttpServer()).get("/docs");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.text).not.toContain("<title>dashboard</title>");
  });

  it("is not swallowed by the dashboard's SPA fallback", async () => {
    await start();
    const res = await request(app.getHttpServer()).get("/docs/json/");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
  });
});
