import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import express from "express";

/**
 * Paths that belong to the API. The SPA fallback must never answer for them: a mistyped API
 * route should be a 404 problem+json, not the dashboard. `/api` covers Better Auth, `/v1` the
 * platform endpoints, and the health routes are plain GETs that a fallback would otherwise eat.
 * A route added outside these prefixes (for example OpenAPI UI in M5-07) must be listed here.
 */
const RESERVED_PREFIXES = ["/api", "/v1", "/healthz", "/readyz"];

/** Decoded, lowercased path without a trailing slash, matched at least as loosely as any router. */
function isReservedPath(rawUrl: string): boolean {
  const raw = new URL(rawUrl, "http://localhost").pathname;
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    path = raw;
  }
  const normalized = path.toLowerCase().replace(/\/+$/, "");
  return RESERVED_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

/**
 * One middleware that serves the built dashboard: real files from `distDir` first, then
 * `index.html` for every other GET/HEAD path so client-side routes survive a reload. Reserved
 * API prefixes and non-GET methods pass through untouched.
 */
export function createWebStatic(distDir: string): RequestHandler {
  const indexFile = join(distDir, "index.html");
  const serveFile = express.static(distDir, { index: false });

  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    if (isReservedPath(req.originalUrl || req.url)) {
      next();
      return;
    }
    serveFile(req, res, () => {
      res.sendFile(indexFile, (error) => {
        if (error) next(error);
      });
    });
  };
}

/**
 * Mounts the dashboard on the Nest app. It is a no-op (returns false) when the build is missing,
 * so the API runs identically without a dashboard. Called before `listen()`/`init()`, which puts
 * it ahead of Nest's routes in the middleware stack; that is safe because it only acts on
 * non-reserved GET/HEAD paths, and Express static only matches files that exist.
 */
export function mountWebApp(app: NestExpressApplication, distDir: string): boolean {
  if (!existsSync(join(distDir, "index.html"))) return false;
  app.use(createWebStatic(distDir));
  return true;
}
