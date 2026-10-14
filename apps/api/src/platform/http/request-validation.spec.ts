import { Body, Controller, Post } from "@nestjs/common";
import { APP_FILTER, APP_PIPE } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { createZodDto } from "nestjs-zod";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ProblemFilter } from "../errors/problem.filter";
import { RequestValidationPipe, toRequestInvalid } from "./request-validation";

const SENTINEL = "secret-sentinel-https://leak.example/path?q=1";

class ProbeDto extends createZodDto(
  z.strictObject({ name: z.string().min(1).max(5), count: z.number().int().optional() }),
) {}

@Controller("pipe-probe")
class ProbeController {
  @Post()
  create(@Body() body: ProbeDto) {
    return { name: body.name };
  }

  // Not a DTO: the pipe must leave it alone.
  @Post("raw")
  raw(@Body() body: unknown) {
    return { received: body !== undefined };
  }
}

let app: Awaited<ReturnType<typeof build>>;

async function build() {
  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
    providers: [
      { provide: APP_PIPE, useClass: RequestValidationPipe },
      { provide: APP_FILTER, useClass: ProblemFilter },
    ],
  }).compile();
  const nest = moduleRef.createNestApplication();
  await nest.init();
  return nest;
}

beforeAll(async () => {
  app = await build();
});
afterAll(async () => {
  await app?.close();
});

const post = (path: string, body: unknown) =>
  request(app.getHttpServer())
    .post(path)
    .send(body as object);

describe("RequestValidationPipe", () => {
  it("passes a valid body through", async () => {
    const res = await post("/pipe-probe", { name: "ok" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ name: "ok" });
  });

  it("answers 400 problem+json request.invalid for an unknown key", async () => {
    const res = await post("/pipe-probe", { name: "ok", [SENTINEL]: 1 });
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 400, code: "request.invalid" });
    expect(res.body.issues).toEqual([{ path: [], message: "Unrecognized key" }]);
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
  });

  it("never echoes a wrong-typed or too-long value", async () => {
    for (const body of [{ name: SENTINEL }, { name: 5 }, { name: "ok", count: SENTINEL }]) {
      const res = await post("/pipe-probe", body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("request.invalid");
      expect(JSON.stringify(res.body)).not.toContain("leak.example");
    }
  });

  it("reports the field path of each issue", async () => {
    const res = await post("/pipe-probe", { name: "" });
    expect(res.body.issues).toEqual([{ path: ["name"], message: "Too short" }]);
  });

  it("does not validate a parameter that is not a DTO", async () => {
    const res = await post("/pipe-probe/raw", { anything: SENTINEL });
    expect(res.status).toBe(201);
  });
});

describe("toRequestInvalid", () => {
  it("passes a non-Zod error through so it surfaces as a 500", () => {
    const error = new Error("boom");
    expect(toRequestInvalid(error)).toBe(error);
  });
});
