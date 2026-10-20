import { describe, expect, it } from "vitest";
import { safeRedirect } from "@/lib/safe-redirect";

// M8-01: where the dashboard goes after login. Only internal paths, so a link to
// `/login?redirect=…` can never send a user to another site (no open redirect).

describe("safeRedirect", () => {
  it.each([
    ["/connect-extension", "/connect-extension"],
    ["/rules", "/rules"],
    ["/events?type=browser.page_visited", "/events?type=browser.page_visited"],
    ["/%2F%2Fevil.com", "/%2F%2Fevil.com"],
  ])("keeps the internal path %s", (input, expected) => {
    expect(safeRedirect(input)).toBe(expected);
  });

  it("drops the fragment (it may hold a secret)", () => {
    expect(safeRedirect("/connect-extension/done#code=ABCD")).toBe("/connect-extension/done");
  });

  it.each([
    "//evil.com",
    "//evil.com/connect-extension",
    "/\\evil.com",
    "\\\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "https://evil.com",
    "http://localhost:3000/rules",
    "javascript:alert(1)",
    "data:text/html,x",
    "connect-extension",
    "",
    " /rules",
    "/login",
    "/login?redirect=/rules",
    "/signup",
    "/setup",
  ])("refuses %j", (input) => {
    expect(safeRedirect(input)).toBeUndefined();
  });

  it.each([undefined, null, 1, {}, ["/rules"]])("refuses a non-string (%j)", (input) => {
    expect(safeRedirect(input)).toBeUndefined();
  });

  it("refuses a very long value", () => {
    expect(safeRedirect(`/${"a".repeat(2048)}`)).toBeUndefined();
  });
});
