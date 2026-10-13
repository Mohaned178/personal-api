import type { IncomingMessage, ServerResponse } from "node:http";
import { Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import { AppException, PROBLEM_CONTENT_TYPE } from "../../platform/errors/problem";
import { toProblem } from "../../platform/errors/problem.filter";
import {
  BODY_LIMIT_BYTES,
  PAYLOAD_TOO_LARGE_CODE,
  PAYLOAD_TOO_LARGE_TITLE,
} from "../../platform/http/body-parser";
import { AUTH_BASE_PATH, SIGNUP_DISABLED_CODE, SIGNUP_DISABLED_TITLE } from "./auth";

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface SignupAdmission {
  admit(signup: () => Promise<void>): Promise<boolean>;
}

/** Express 5 route pattern for everything under the Better Auth base path. */
export const AUTH_ROUTE = `${AUTH_BASE_PATH}/{*splat}`;

const logger = new Logger("AuthHttp");

/** The request path, normalized at least as loosely as any router could read it. */
function normalizedPath(req: Request): string {
  const raw = new URL(req.originalUrl || req.url, "http://localhost").pathname;
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    path = raw;
  }
  return path.toLowerCase().replace(/\/+$/, "");
}

export function isAuthPath(req: Request): boolean {
  const path = normalizedPath(req);
  return path === AUTH_BASE_PATH || path.startsWith(`${AUTH_BASE_PATH}/`);
}

/**
 * Every account-creating route goes through the signup gate. Matching on the loosely normalized
 * prefix errs towards gating too much, never too little.
 */
export function isSignUpPath(req: Request): boolean {
  return normalizedPath(req).startsWith(`${AUTH_BASE_PATH}/sign-up`);
}

/** The same limit the body parser applies to every other route. */
export const AUTH_BODY_LIMIT_BYTES = BODY_LIMIT_BYTES;

/**
 * Better Auth buffers the whole request body with no size limit, so the size is judged from the
 * headers before anything reads the body. A body of undeclared length (chunked transfer
 * encoding) is refused too: it could be any size. No Content-Length and no Transfer-Encoding
 * means no body (RFC 9112 §6.3), which is fine.
 */
export function isBodyTooLarge(req: Pick<Request, "headers">): boolean {
  if (req.headers["transfer-encoding"] !== undefined) return true;
  const declared = req.headers["content-length"];
  if (declared === undefined) return false;
  const bytes = Number(declared);
  return !Number.isSafeInteger(bytes) || bytes < 0 || bytes > AUTH_BODY_LIMIT_BYTES;
}

function sendProblem(res: Response, exception: unknown): void {
  const problem = toProblem(exception);
  res.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

/**
 * Wraps Better Auth's Node handler: oversized or unbounded bodies are refused first (413
 * problem+json, `http.payload_too_large`, without reading the body or touching the signup lock),
 * signups then pass through the gate (a refusal is a 403 problem+json, `auth.signup_disabled`),
 * and an unexpected failure becomes a 500 problem+json rather than reaching Express's default
 * handler, which would print the error and stack.
 */
export function createAuthRequestHandler(handle: NodeHandler, gate: SignupAdmission) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      if (isBodyTooLarge(req)) {
        // The body is never read, so close the connection rather than drain it.
        res.set("Connection", "close");
        sendProblem(res, new AppException(413, PAYLOAD_TOO_LARGE_CODE, PAYLOAD_TOO_LARGE_TITLE));
        return;
      }
      if (isSignUpPath(req)) {
        const admitted = await gate.admit(() => handle(req, res));
        if (!admitted) {
          sendProblem(res, new AppException(403, SIGNUP_DISABLED_CODE, SIGNUP_DISABLED_TITLE));
        }
        return;
      }
      await handle(req, res);
    } catch (error) {
      // Name only: messages can carry user data (invariant 6).
      logger.error(`Auth request failed: ${error instanceof Error ? error.name : "unknown"}`);
      if (!res.headersSent) sendProblem(res, error);
      else res.destroy();
    }
  };
}
