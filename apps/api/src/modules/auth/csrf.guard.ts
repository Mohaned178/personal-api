import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { CSRF_ORIGIN_INVALID_CODE } from "@personal-api/contracts";
import type { Request } from "express";
import type { AppConfig } from "../../config/config";
import { APP_CONFIG } from "../../config/config.module";
import { AppException } from "../../platform/errors/problem";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for every state-changing request that carries cookies (Better Auth's own routes
 * check Origin themselves). A browser always sends `Origin` on POST/PATCH/PUT/DELETE, so:
 *
 * - an `Origin` that is not the dashboard's own origin (including `null`) is refused;
 * - without `Origin`, a browser still says `Sec-Fetch-Site`, and anything but `same-origin` or
 *   `none` is refused;
 * - with neither header the caller is not a browser, which is the only thing that attaches
 *   someone else's session cookie on its own, so the request passes.
 *
 * Requests without a cookie are not checked: ingest keys travel in `Authorization`,
 * which a cross-site page cannot set.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly trustedOrigin: string;

  constructor(@Inject(APP_CONFIG) config: Pick<AppConfig, "BETTER_AUTH_URL">) {
    this.trustedOrigin = new URL(config.BETTER_AUTH_URL).origin;
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
    if (typeof req.headers.cookie !== "string" || req.headers.cookie === "") return true;

    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (origin === this.trustedOrigin) return true;
    } else {
      const site = req.headers["sec-fetch-site"];
      if (site === undefined || site === "same-origin" || site === "none") return true;
    }
    throw new AppException(403, CSRF_ORIGIN_INVALID_CODE, "Request origin is not allowed");
  }
}
