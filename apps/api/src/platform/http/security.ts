import type { INestApplication } from "@nestjs/common";
import type { Express } from "express";
import helmet from "helmet";

/**
 * Security headers and client-address handling, applied to the real app and to test apps alike.
 * Call before `init()` / `listen()` so the headers cover every response, including 404s and the
 * static dashboard.
 *
 * - `trust proxy` is the number of reverse proxies in front (0 = none): Express then derives
 *   `req.ip` from that many `X-Forwarded-For` hops, and never from more.
 * - helmet's defaults, except `upgrade-insecure-requests`: it would make a browser rewrite the
 *   dashboard's own requests to https on a plain-http self-hosted setup and break it.
 */
export function applyHttpHardening(app: INestApplication, trustProxyHops: number): void {
  const express = app.getHttpAdapter().getInstance() as Express;
  express.set("trust proxy", trustProxyHops > 0 ? trustProxyHops : false);
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: { upgradeInsecureRequests: null },
      },
    }),
  );
}
