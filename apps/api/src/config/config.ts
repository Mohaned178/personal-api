import { z } from "zod";

const FORBIDDEN_DB_PORT = "5432";

/**
 * pg-connection-string lets `?host=` and `?port=` override the URL authority, so a URL that looks
 * like it targets 5433 could still reach 5432 (or another host). Both are rejected outright.
 */
const OVERRIDING_DB_PARAMS = ["host", "port"];

/** The project database lives on 5433 (compose) or Testcontainers. 5432 is a personal server. */
const databaseUrl = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        if (OVERRIDING_DB_PARAMS.some((param) => url.searchParams.has(param))) return false;
        // An empty port means the protocol default, which for Postgres is 5432.
        return (url.port || FORBIDDEN_DB_PORT) !== FORBIDDEN_DB_PORT;
      } catch {
        return false;
      }
    },
    {
      message:
        "DATABASE_URL must be a valid URL with an explicit port other than 5432 and no host or port query parameters",
    },
  );

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** In production the session cookie must be Secure, so plain http is only allowed on loopback. */
function isSecureOrLoopback(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Only the exact strings "true" and "false" are accepted. z.coerce.boolean() would read "false"
 * as true and silently open signups; anything unrecognized is rejected so a typo fails closed.
 * Unset means false: only the first account can sign up.
 */
const allowSignup = z
  .enum(["true", "false"], { message: 'ALLOW_SIGNUP must be "true" or "false"' })
  .transform((value) => value === "true")
  .default(false);

export const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_URL: databaseUrl,
    ALLOW_SIGNUP: allowSignup,
    /** Signs session cookies. Generate with `openssl rand -base64 32`. */
    BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
    /** The public origin of the API and dashboard, for example https://pa.example.com. */
    BETTER_AUTH_URL: z.url({
      protocol: /^https?$/,
      message: "BETTER_AUTH_URL must be an http(s) URL",
    }),
    /** Directory with the built dashboard. Defaults to apps/web/dist next to the API package. */
    WEB_DIST_DIR: z.string().min(1).optional(),
  })
  .refine(
    (config) => config.NODE_ENV !== "production" || isSecureOrLoopback(config.BETTER_AUTH_URL),
    {
      path: ["BETTER_AUTH_URL"],
      message: "BETTER_AUTH_URL must use https in production unless the host is loopback",
    },
  );

export type AppConfig = z.infer<typeof configSchema>;

/** Parses env vars. Throws a message listing the invalid keys, never their values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return result.data;
}
