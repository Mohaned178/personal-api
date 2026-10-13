import { HttpException } from "@nestjs/common";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { isAuthPath } from "../../modules/auth/auth.http";
import { AppException } from "../errors/problem";
import { createBodyParser, PAYLOAD_TOO_LARGE_CODE } from "./body-parser";

describe("createBodyParser", () => {
  function app() {
    const server = express();
    server.use(createBodyParser({ skip: isAuthPath }));
    server.post("/{*splat}", (request, response) => {
      response.json({ body: request.body ?? null, readable: request.readable });
    });
    // Reports what the body parser handed on, the way Nest's ProblemFilter would see it.
    server.use((error: unknown, _req: Request, response: Response, _next: NextFunction) => {
      response.status(599).json({
        httpException: error instanceof HttpException,
        status: error instanceof HttpException ? error.getStatus() : null,
        code: error instanceof AppException ? error.code : null,
        message: error instanceof Error ? error.message : null,
      });
    });
    return server;
  }

  it("parses JSON for ordinary routes", async () => {
    const res = await request(app()).post("/v1/things").send({ a: 1 });
    expect(res.body.body).toEqual({ a: 1 });
  });

  it("parses urlencoded forms for ordinary routes", async () => {
    const res = await request(app()).post("/v1/things").type("form").send("a=1");
    expect(res.body.body).toEqual({ a: "1" });
  });

  it("leaves the raw stream untouched for Better Auth routes", async () => {
    const res = await request(app()).post("/api/auth/sign-in/email").send({ a: 1 });
    expect(res.body).toEqual({ body: null, readable: true });
  });

  it("turns a JSON body over 100 kb into a 413 http.payload_too_large exception", async () => {
    const res = await request(app())
      .post("/v1/things")
      .send({ a: "x".repeat(101 * 1024) });
    expect(res.body).toMatchObject({
      httpException: true,
      status: 413,
      code: PAYLOAD_TOO_LARGE_CODE,
    });
  });

  it("turns malformed JSON into a 400 exception that does not quote the body", async () => {
    const res = await request(app())
      .post("/v1/things")
      .set("Content-Type", "application/json")
      .send('{"email": a@b.test}');
    expect(res.body).toMatchObject({ httpException: true, status: 400 });
    expect(res.text).not.toContain("a@b.test");
  });
});
