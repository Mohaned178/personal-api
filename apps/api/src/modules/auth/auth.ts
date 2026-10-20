import { Logger } from "@nestjs/common";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import type { AppConfig } from "../../config/config";
import type { Database } from "../../platform/db/db";
import { account, session, user, verification } from "../../platform/db/schema";

/** Where Better Auth's routes live (sign-up/email, sign-in/email, sign-out, get-session, ...). */
export const AUTH_BASE_PATH = "/api/auth";

/**
 * The header Better Auth reads the client address from. The auth route handler overwrites it with
 * Express's `req.ip` on every request (auth.http.ts), so a client-sent value never counts and the
 * login rate limit follows the same TRUST_PROXY setting as every other limit.
 */
export const CLIENT_IP_HEADER = "x-pa-client-ip";

export const SIGNUP_DISABLED_CODE = "auth.signup_disabled";
export const SIGNUP_DISABLED_TITLE = "Signups are disabled";

export interface CreateAuthOptions {
  config: Pick<AppConfig, "NODE_ENV" | "BETTER_AUTH_SECRET" | "BETTER_AUTH_URL">;
  db: Database;
  /** Asked before every user row is created. Defense in depth behind the HTTP signup gate. */
  canCreateUser: () => Promise<boolean>;
}

const logger = new Logger("BetterAuth");

/**
 * Better Auth's log messages and arguments can carry emails, URLs and database errors with row
 * values, so only the level and the names of any errors are forwarded (invariant 6).
 */
export function logSafely(level: string, _message: string, ...args: unknown[]): void {
  const names = args.filter((arg): arg is Error => arg instanceof Error).map((err) => err.name);
  const text = `Better Auth ${level}${names.length > 0 ? `: ${names.join(", ")}` : ""}`;
  if (level === "error") logger.error(text);
  else if (level === "warn") logger.warn(text);
  else logger.debug(text);
}

export function createAuth({ config, db, canCreateUser }: CreateAuthOptions) {
  return betterAuth({
    appName: "Personal API",
    baseURL: config.BETTER_AUTH_URL,
    basePath: AUTH_BASE_PATH,
    secret: config.BETTER_AUTH_SECRET,
    // The dashboard is served by the API itself, so only our own origin may call auth routes.
    trustedOrigins: [new URL(config.BETTER_AUTH_URL).origin],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification },
      // Sign-up writes user + account + session in one transaction: a half-created owner
      // account could otherwise block every later signup while being unable to log in.
      transaction: true,
    }),
    emailAndPassword: {
      enabled: true,
      // No email delivery in v1.
      requireEmailVerification: false,
      autoSignIn: true,
    },
    advanced: {
      // HttpOnly + SameSite=Lax are Better Auth's defaults; Secure follows the public URL.
      useSecureCookies: config.BETTER_AUTH_URL.startsWith("https://"),
      // Better Auth defaults this to true under NODE_ENV=test, which also disables its CSRF
      // check. Pin it off everywhere so foreign-origin requests are refused in every env.
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    // Set explicitly from the validated config rather than left to Better Auth's own default
    // (production only), so a self-hoster who never sets NODE_ENV (it defaults to development)
    // still gets it. Only the test suites turn it off. The client address comes from
    // CLIENT_IP_HEADER (see above), so sign-in and sign-up are limited per address (3 per 10 s,
    // Better Auth's default special rule).
    rateLimit: { enabled: config.NODE_ENV !== "test" },
    telemetry: { enabled: false },
    logger: { log: logSafely },
    // Without this, better-call answers an unexpected (non-APIError) failure itself with a bare
    // 500 after `console.error`-ing the raw error, and a Drizzle error message carries the SQL
    // and its params (an email on sign-in), bypassing pino (invariant 6). With `throw: true` the
    // router still turns APIErrors into normal responses but rethrows everything else out of
    // `auth.handler`, where createAuthRequestHandler logs the error name only and answers 500
    // problem+json.
    //
    // Known remaining direct console write: @better-auth/core's adapter factory also calls
    // `console.error(error)` when a *fallback join* query fails (a second query run because
    // `advanced.database.joins` is off). That happens only if the DB fails between the base query
    // and the join query. It cannot be hooked from options, and silencing it would mean patching
    // the global console, so it is left as is; enabling native joins (needs Drizzle relations)
    // would remove the path entirely.
    onAPIError: { throw: true },
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            if (!(await canCreateUser())) {
              throw new APIError("FORBIDDEN", {
                code: SIGNUP_DISABLED_CODE,
                message: SIGNUP_DISABLED_TITLE,
              });
            }
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
