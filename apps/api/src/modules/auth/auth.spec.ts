import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../../platform/db/db";
import { createAuth, logSafely } from "./auth";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logSafely (Better Auth logger)", () => {
  it("forwards the level and error names, never the message or other arguments", () => {
    const lines: string[] = [];
    for (const level of ["error", "warn", "debug"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        lines.push(String(message));
      });
    }

    const dbError = Object.assign(new TypeError("duplicate key: (email)=(a@b.test)"), {
      detail: "Key (email)=(a@b.test) already exists.",
    });
    logSafely("info", "Sign-up attempt for existing email: a@b.test");
    logSafely("error", "Invalid origin: https://evil.example/path?q=1", { email: "a@b.test" });
    logSafely("error", "Failed to create user", dbError);
    logSafely("warn", "User not found", { email: "a@b.test", password: "hunter2" });

    const output = lines.join("\n");
    expect(lines).toHaveLength(4);
    expect(output).toContain("TypeError");
    for (const secret of ["a@b.test", "evil.example", "hunter2", "existing email", "Key (email)"]) {
      expect(output, `leaked: ${secret}`).not.toContain(secret);
    }
  });
});

describe("createAuth rate limiting", () => {
  const baseConfig = {
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
    BETTER_AUTH_URL: "http://localhost:3000",
  };
  const build = (NODE_ENV: "development" | "test" | "production") =>
    createAuth({
      config: { ...baseConfig, NODE_ENV },
      // The adapter is lazy: no query runs while building, so a stand-in is enough here.
      db: {} as unknown as Database,
      canCreateUser: async () => true,
    });

  // Read through a structural type so this file compiles before the option is set.
  const rateLimitOf = (auth: ReturnType<typeof build>) =>
    (auth.options as { rateLimit?: { enabled?: boolean } }).rateLimit;

  // M7-04: NODE_ENV defaults to development, so "production only" left most self-hosted
  // installs without a login limit.
  it.each(["production", "development"] as const)(
    "sets rateLimit explicitly and enables it when NODE_ENV is %s",
    (env) => {
      const rateLimit = rateLimitOf(build(env));
      expect(rateLimit).toBeDefined();
      expect(rateLimit?.enabled).toBe(true);
    },
  );

  it("sets rateLimit explicitly and disables it only when NODE_ENV is test", () => {
    const rateLimit = rateLimitOf(build("test"));
    expect(rateLimit).toBeDefined();
    expect(rateLimit?.enabled).toBe(false);
  });

  it("follows the validated config, not process.env.NODE_ENV", () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(rateLimitOf(build("test"))?.enabled).toBe(false);
      process.env.NODE_ENV = "test";
      expect(rateLimitOf(build("production"))?.enabled).toBe(true);
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});
