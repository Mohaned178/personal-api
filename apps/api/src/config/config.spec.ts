import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const ok = {
  DATABASE_URL: "postgres://app:secret@localhost:5433/personal_api",
  BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:3000",
};

describe("loadConfig", () => {
  it("applies defaults and accepts a DATABASE_URL on 5433", () => {
    const config = loadConfig(ok);
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.DATABASE_URL).toBe(ok.DATABASE_URL);
  });

  it("coerces PORT from a string", () => {
    expect(loadConfig({ ...ok, PORT: "4010" }).PORT).toBe(4010);
  });

  it("rejects a DATABASE_URL on port 5432", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: "postgres://app:secret@localhost:5432/personal_api" }),
    ).toThrow(/5432/);
  });

  it("rejects a DATABASE_URL with no port (defaults to 5432)", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: "postgres://app:secret@localhost/personal_api" }),
    ).toThrow(/5432/);
  });

  it("rejects a missing or malformed DATABASE_URL without echoing its value", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: "not a url, hunter2" })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: "not a url, hunter2" })).not.toThrow(/hunter2/);
  });

  it("defaults ALLOW_SIGNUP to false (only the first account can sign up)", () => {
    expect(loadConfig(ok).ALLOW_SIGNUP).toBe(false);
  });

  it("requires a BETTER_AUTH_SECRET of at least 32 characters without echoing it", () => {
    const { BETTER_AUTH_SECRET: _, ...noSecret } = ok;
    expect(() => loadConfig(noSecret)).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => loadConfig({ ...ok, BETTER_AUTH_SECRET: "short-hunter2" })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
    expect(() => loadConfig({ ...ok, BETTER_AUTH_SECRET: "short-hunter2" })).not.toThrow(/hunter2/);
  });

  it("requires BETTER_AUTH_URL to be an http(s) URL", () => {
    const { BETTER_AUTH_URL: _, ...noUrl } = ok;
    expect(() => loadConfig(noUrl)).toThrow(/BETTER_AUTH_URL/);
    expect(() => loadConfig({ ...ok, BETTER_AUTH_URL: "localhost:3000" })).toThrow(
      /BETTER_AUTH_URL/,
    );
    expect(() => loadConfig({ ...ok, BETTER_AUTH_URL: "ftp://example.test" })).toThrow(
      /BETTER_AUTH_URL/,
    );
  });

  it("rejects an invalid PORT or LOG_LEVEL", () => {
    expect(() => loadConfig({ ...ok, PORT: "70000" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...ok, LOG_LEVEL: "loud" })).toThrow(/LOG_LEVEL/);
  });
});
