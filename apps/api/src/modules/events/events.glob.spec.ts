import { describe, expect, it } from "vitest";
import { globToLike } from "./events.repository";

describe("globToLike", () => {
  it("escapes _ (a LIKE wildcard) and turns * into %", () => {
    expect(globToLike("browser.*")).toBe("browser.%");
    expect(globToLike("a_b*")).toBe("a\\_b%");
    expect(globToLike("*.page_visited")).toBe("%.page\\_visited");
  });

  it.each(["", "a b", "A", "a%b", "a'b", "a\\b", "a?"])("refuses %j", (pattern) => {
    expect(() => globToLike(pattern)).toThrow();
  });
});
