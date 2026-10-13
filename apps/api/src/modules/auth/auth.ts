import { Logger } from "@nestjs/common";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import type { AppConfig } from "../../config/config";
import type { Database } from "../../platform/db/db";
import { account, session, user, verification } from "../../platform/db/schema";

/** Where Better Auth's routes live (sign-up/email, sign-in/email, sign-out, get-session, ...). */
export const AUTH_BASE_PATH = "/api/auth";

export const SIGNUP_DISABLED_CODE = "auth.signup_disabled";
export const SIGNUP_DISABLED_TITLE = "Signups are disabled";

export interface CreateAuthOptions {
  config: Pick<AppConfig, "BETTER_AUTH_SECRET" | "BETTER_AUTH_URL">;
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
    },
    telemetry: { enabled: false },
    logger: { log: logSafely },
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
