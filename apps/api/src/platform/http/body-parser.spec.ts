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

  describe("largeJsonRoutes", () => {
    const LARGE = 256 * 1024;

    function largeApp() {
      const server = express();
      server.use(
        createBodyParser({
          skip: isAuthPath,
          largeJsonRoutes: [{ method: "POST", path: "/v1/big", limitBytes: LARGE }],
        }),
      );
      server.all("/{*splat}", (request, response) => {
        response.json({ parsed: request.body !== undefined });
      });
      server.use((error: unknown, _req: Request, response: Response, _next: NextFunction) => {
        response.status(599).json({ code: error instanceof AppException ? error.code : null });
      });
      return server;
    }

    /** A JSON text of exactly `bytes` bytes. */
    function jsonOfSize(bytes: number): string {
      const empty = JSON.stringify({ pad: "" });
      return JSON.stringify({ pad: "x".repeat(bytes - Buffer.byteLength(empty)) });
    }

    const send = (method: "post" | "put", path: string, bytes: number) =>
      request(largeApp())
        [method](path)
        .set("Content-Type", "application/json")
        .send(jsonOfSize(bytes));

    it("parses a body up to the route's limit, inclusive, on the exact method and path", async () => {
      expect((await send("post", "/v1/big", LARGE)).body).toEqual({ parsed: true });
    });

    it("refuses one byte over the route's limit with 413 http.payload_too_large", async () => {
      const res = await send("post", "/v1/big", LARGE + 1);
      expect(res.body).toEqual({ code: PAYLOAD_TOO_LARGE_CODE });
    });

    it("ignores the query string when matching the path", async () => {
      expect((await send("post", "/v1/big?x=1", 200 * 1024)).body).toEqual({ parsed: true });
    });

    it.each([
      ["a lookalike prefix", "post", "/v1/big-archive"],
      ["a sub-path", "post", "/v1/big/extra"],
      ["a parent path", "post", "/v1"],
      ["a trailing slash", "post", "/v1/big/"],
      ["another casing", "post", "/V1/BIG"],
      ["an encoded character", "post", "/v1/%62ig"],
      ["another method", "put", "/v1/big"],
    ] as const)("keeps the 100 kb default for %s", async (_name, method, path) => {
      const res = await send(method, path, 150 * 1024);
      expect(res.body).toEqual({ code: PAYLOAD_TOO_LARGE_CODE });
    });

    it("keeps the 100 kb default for urlencoded bodies on the large route", async () => {
      const res = await request(largeApp())
        .post("/v1/big")
        .type("form")
        .send(`a=${"x".repeat(150 * 1024)}`);
      expect(res.body).toEqual({ code: PAYLOAD_TOO_LARGE_CODE });
    });

    it("still leaves Better Auth's raw stream alone", async () => {
      const res = await send("post", "/api/auth/sign-in/email", 1024);
      expect(res.body).toEqual({ parsed: false });
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
