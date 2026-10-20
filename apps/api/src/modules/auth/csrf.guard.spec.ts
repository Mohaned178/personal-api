import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { AppException } from "../../platform/errors/problem";
import { CsrfGuard } from "./csrf.guard";

const guard = new CsrfGuard({ BETTER_AUTH_URL: "https://pa.example.com/some/path" });

function run(method: string, headers: Record<string, string>): boolean {
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ method, headers }) }),
  } as unknown as ExecutionContext;
  return guard.canActivate(context);
}

function refusal(method: string, headers: Record<string, string>): AppException {
  try {
    run(method, headers);
  } catch (error) {
    return error as AppException;
  }
  throw new Error("expected the guard to refuse");
}

const COOKIE = { cookie: "better-auth.session_token=abc" };

describe("CsrfGuard", () => {
  it.each(["POST", "PATCH", "PUT", "DELETE"])(
    "refuses a cookie %s from a foreign Origin with 403 auth.csrf_origin_invalid",
    (method) => {
      const error = refusal(method, { ...COOKIE, origin: "https://evil.example" });
      expect(error.getStatus()).toBe(403);
      expect(error.code).toBe("auth.csrf_origin_invalid");
    },
  );

  it.each(["null", "https://pa.example.com.evil.example", "http://pa.example.com", ""])(
    "refuses the look-alike Origin %j",
    (origin) => {
      expect(refusal("POST", { ...COOKIE, origin }).code).toBe("auth.csrf_origin_invalid");
    },
  );

  it("allows the dashboard's own origin", () => {
    expect(run("DELETE", { ...COOKIE, origin: "https://pa.example.com" })).toBe(true);
  });

  it("without Origin, refuses a browser that says the request is cross-site or same-site", () => {
    for (const site of ["cross-site", "same-site"]) {
      expect(refusal("POST", { ...COOKIE, "sec-fetch-site": site }).code).toBe(
        "auth.csrf_origin_invalid",
      );
    }
  });

  it("without Origin, allows same-origin, user-initiated and non-browser requests", () => {
    expect(run("POST", { ...COOKIE, "sec-fetch-site": "same-origin" })).toBe(true);
    expect(run("POST", { ...COOKIE, "sec-fetch-site": "none" })).toBe(true);
    expect(run("POST", COOKIE)).toBe(true);
  });

  it("Origin wins over Sec-Fetch-Site", () => {
    const headers = { ...COOKIE, origin: "https://evil.example", "sec-fetch-site": "same-origin" };
    expect(refusal("POST", headers).code).toBe("auth.csrf_origin_invalid");
  });

  it("does not check safe methods or requests without a cookie", () => {
    expect(run("GET", { ...COOKIE, origin: "https://evil.example" })).toBe(true);
    expect(run("HEAD", { ...COOKIE, origin: "https://evil.example" })).toBe(true);
    expect(run("POST", { origin: "https://evil.example" })).toBe(true);
    expect(run("POST", { cookie: "", origin: "https://evil.example" })).toBe(true);
  });
});
