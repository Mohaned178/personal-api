import type { IncomingMessage, ServerResponse } from "node:http";
import { Logger } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import { AppException, PROBLEM_CONTENT_TYPE } from "../../platform/errors/problem";
import { toProblem } from "../../platform/errors/problem.filter";
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

function sendProblem(res: Response, exception: unknown): void {
  const problem = toProblem(exception);
  res.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

/**
 * Wraps Better Auth's Node handler: signups pass through the gate first (a refusal is a 403
 * problem+json, `auth.signup_disabled`), and an unexpected failure becomes a 500 problem+json
 * rather than reaching Express's default handler, which would print the error and stack.
 */
export function createAuthRequestHandler(handle: NodeHandler, gate: SignupAdmission) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
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

/**
 * The app runs with Nest's global body parser off, because Better Auth reads the raw request
 * stream. This restores Nest's default JSON and urlencoded parsing for every other route.
 */
export function createBodyParser() {
  const json = express.json();
  const urlencoded = express.urlencoded({ extended: true });
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isAuthPath(req)) {
      next();
      return;
    }
    json(req, res, (error?: unknown) => (error ? next(error) : urlencoded(req, res, next)));
  };
}
