import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logSafely } from "./auth";

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
