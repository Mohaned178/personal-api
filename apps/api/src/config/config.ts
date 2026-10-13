import { z } from "zod";

const FORBIDDEN_DB_PORT = "5432";

/** The project database lives on 5433 (compose) or Testcontainers. 5432 is a personal server. */
const databaseUrl = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        // An empty port means the protocol default, which for Postgres is 5432.
        return (url.port || FORBIDDEN_DB_PORT) !== FORBIDDEN_DB_PORT;
      } catch {
        return false;
      }
    },
    { message: "DATABASE_URL must be a valid URL and must not use port 5432" },
  );

export const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: databaseUrl,
});

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
