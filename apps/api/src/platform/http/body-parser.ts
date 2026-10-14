import { HttpException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import { AppException } from "../errors/problem";

/**
 * Express's default body limit, applied to every parsed route (except the few listed in
 * `largeJsonRoutes`) and to Better Auth's routes.
 */
export const BODY_LIMIT_BYTES = 100 * 1024;
export const PAYLOAD_TOO_LARGE_CODE = "http.payload_too_large";
export const PAYLOAD_TOO_LARGE_TITLE = "Payload too large";

/** One route that may send a JSON body larger than `BODY_LIMIT_BYTES`. */
export interface LargeJsonRoute {
  /** Upper-case HTTP method, for example `POST`. */
  method: string;
  /** The exact request path, for example `/v1/ingest/events`. */
  path: string;
  limitBytes: number;
}

export interface BodyParserOptions {
  /** Requests this returns true for keep their raw, unread body stream. */
  skip: (req: Request) => boolean;
  /**
   * JSON routes allowed a larger body. A request matches only on its exact method and path (the
   * query string is ignored): a lookalike prefix, a sub-path, another casing or a trailing slash
   * keeps the default limit. Mismatches can only narrow the limit, never widen it.
   */
  largeJsonRoutes?: readonly LargeJsonRoute[];
}

/**
 * body-parser reports client mistakes (malformed JSON, too large, bad charset) as plain errors
 * with a 4xx `status`. ProblemFilter would turn those into 500s, so they become Nest exceptions
 * here. The original message is dropped: JSON.parse messages quote the body (invariant 6).
 */
function toHttpException(error: unknown): unknown {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== "number" || status < 400 || status > 499) return error;
  if (status === 413) {
    return new AppException(413, PAYLOAD_TOO_LARGE_CODE, PAYLOAD_TOO_LARGE_TITLE);
  }
  return new HttpException("Invalid request body", status);
}

/** The raw request path without the query string. Not decoded or normalized: matched exactly. */
function requestPath(req: Request): string {
  const url = req.originalUrl || req.url || "";
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

/**
 * The app runs with Nest's global body parser off, because Better Auth reads the raw request
 * stream. This restores Nest's default JSON and urlencoded parsing (100 kb limit) for every route
 * that `skip` does not claim, with a larger JSON limit for the routes in `largeJsonRoutes`.
 */
export function createBodyParser({ skip, largeJsonRoutes = [] }: BodyParserOptions) {
  const json = express.json({ limit: BODY_LIMIT_BYTES });
  const urlencoded = express.urlencoded({ extended: true, limit: BODY_LIMIT_BYTES });
  const large = largeJsonRoutes.map((route) => ({
    method: route.method,
    path: route.path,
    json: express.json({ limit: route.limitBytes }),
  }));
  return (req: Request, res: Response, next: NextFunction): void => {
    if (skip(req)) {
      next();
      return;
    }
    const path = requestPath(req);
    const parseJson =
      large.find((route) => route.method === req.method && route.path === path)?.json ?? json;
    parseJson(req, res, (jsonError?: unknown) => {
      if (jsonError) {
        next(toHttpException(jsonError));
        return;
      }
      urlencoded(req, res, (formError?: unknown) =>
        formError ? next(toHttpException(formError)) : next(),
      );
    });
  };
}
