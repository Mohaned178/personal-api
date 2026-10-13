import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const ok = { DATABASE_URL: "postgres://app:secret@localhost:5433/personal_api" };

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

  it("rejects an invalid PORT or LOG_LEVEL", () => {
    expect(() => loadConfig({ ...ok, PORT: "70000" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...ok, LOG_LEVEL: "loud" })).toThrow(/LOG_LEVEL/);
  });
});
