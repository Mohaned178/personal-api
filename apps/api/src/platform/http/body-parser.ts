import { HttpException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import { AppException } from "../errors/problem";

/** Express's default body limit, applied to every parsed route and to Better Auth's routes. */
export const BODY_LIMIT_BYTES = 100 * 1024;
export const PAYLOAD_TOO_LARGE_CODE = "http.payload_too_large";
export const PAYLOAD_TOO_LARGE_TITLE = "Payload too large";

export interface BodyParserOptions {
  /** Requests this returns true for keep their raw, unread body stream. */
  skip: (req: Request) => boolean;
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

/**
 * The app runs with Nest's global body parser off, because Better Auth reads the raw request
 * stream. This restores Nest's default JSON and urlencoded parsing (100 kb limit) for every route
 * that `skip` does not claim.
 */
export function createBodyParser({ skip }: BodyParserOptions) {
  const json = express.json({ limit: BODY_LIMIT_BYTES });
  const urlencoded = express.urlencoded({ extended: true, limit: BODY_LIMIT_BYTES });
  return (req: Request, res: Response, next: NextFunction): void => {
    if (skip(req)) {
      next();
      return;
    }
    json(req, res, (jsonError?: unknown) => {
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
