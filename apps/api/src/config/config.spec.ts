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

  it.each([
    [
      "a ?port=5432 query override of a 5433 authority",
      "postgres://u:p@localhost:5433/db?port=5432",
    ],
    [
      "a ?port=5432 override when the authority has no port",
      "postgres://u:p@localhost/db?port=5432",
    ],
    ["a ?port query param even when it is 5433", "postgres://u:p@localhost:5433/db?port=5433"],
    ["a ?port query param on an otherwise portless URL", "postgres://u:p@localhost/db?port=5433"],
    [
      "a ?port param among other params",
      "postgres://u:p@localhost:5433/db?sslmode=disable&port=5432",
    ],
    [
      "a ?host query param that overrides the authority",
      "postgres://u:p@localhost:5433/db?host=other.example",
    ],
    ["a ?host unix-socket override", "postgres://u:p@localhost:5433/db?host=/var/run/postgresql"],
    [
      "a ?host param even when it matches the authority",
      "postgres://u:p@localhost:5433/db?host=localhost",
    ],
  ])("rejects a DATABASE_URL with %s", (_label, url) => {
    expect(() => loadConfig({ ...ok, DATABASE_URL: url })).toThrow(/DATABASE_URL/);
  });

  it("does not echo the DATABASE_URL credentials when rejecting a port override", () => {
    const url = "postgres://app:hunter2@localhost:5433/db?port=5432";
    expect(() => loadConfig({ ...ok, DATABASE_URL: url })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...ok, DATABASE_URL: url })).not.toThrow(/hunter2/);
  });

  it("still accepts valid 5433 URLs, with or without harmless query params", () => {
    for (const url of [
      "postgres://app:secret@localhost:5433/personal_api",
      "postgresql://app:secret@127.0.0.1:5433/personal_api",
      "postgres://app:secret@localhost:5433/personal_api?sslmode=disable",
      "postgres://app:secret@db.internal:5434/personal_api",
    ]) {
      expect(loadConfig({ ...ok, DATABASE_URL: url }).DATABASE_URL).toBe(url);
    }
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

  describe("BETTER_AUTH_URL in production", () => {
    const prod = { ...ok, NODE_ENV: "production" };

    it("accepts an https URL", () => {
      const config = loadConfig({ ...prod, BETTER_AUTH_URL: "https://pa.example.com" });
      expect(config.BETTER_AUTH_URL).toBe("https://pa.example.com");
    });

    it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])(
      "accepts plain http on the loopback host %s",
      (url) => {
        expect(loadConfig({ ...prod, BETTER_AUTH_URL: url }).BETTER_AUTH_URL).toBe(url);
      },
    );

    it.each([
      "http://pa.example.com",
      "http://192.168.1.10:3000",
      "http://10.0.0.5",
      "http://localhost.example.com",
      "http://127.0.0.1.example.com",
      "http://pa.example.com/localhost",
    ])("rejects plain http on the non-loopback host %s", (url) => {
      expect(() => loadConfig({ ...prod, BETTER_AUTH_URL: url })).toThrow(/BETTER_AUTH_URL/);
    });

    it("leaves development, test and unset NODE_ENV unaffected (http non-loopback allowed)", () => {
      for (const env of [{ NODE_ENV: "development" }, { NODE_ENV: "test" }, {}]) {
        const url = "http://pa.example.com";
        expect(loadConfig({ ...ok, ...env, BETTER_AUTH_URL: url }).BETTER_AUTH_URL).toBe(url);
      }
    });
  });
});
