import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { globMatches } from "./rule-glob.js";

describe("globMatches: `*` is the only wildcard", () => {
  it.each([
    ["browser.*", "browser.page_visited", true],
    ["browser.*", "browser.", true],
    ["browser.*", "browse", false],
    ["*", "", true],
    ["*", "anything at all", true],
    ["*.pdf", "/docs/a.pdf", true],
    ["*.pdf", "/docs/a.pdf.txt", false],
    ["/a/*/c", "/a/b/c", true],
    ["/a/*/c", "/a/b/x/c", true],
    ["/a/*/c", "/a/c", false],
    ["a*b*c", "abc", true],
    ["a*b*c", "aXXbYYc", true],
    ["a*b*c", "aXXcYYb", false],
    ["abc", "abc", true],
    ["abc", "ABC", false],
    ["", "", true],
    ["", "a", false],
    // Everything but `*` is literal: no `?`, no classes, no regex.
    ["a?c", "abc", false],
    ["a?c", "a?c", true],
    ["[ab]", "a", false],
    ["[ab]", "[ab]", true],
    ["a.c", "abc", false],
    ["(a|b)", "a", false],
    ["a+", "aa", false],
  ])("globMatches(%j, %j) is %s", (pattern, text, expected) => {
    expect(globMatches(pattern, text)).toBe(expected);
  });

  it("is case-sensitive and compares by UTF-16 code unit", () => {
    expect(globMatches("é*", "éa")).toBe(true);
    expect(globMatches("*😀", "a😀")).toBe(true);
  });

  it("without a `*` it is plain equality", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.includes("*")),
        fc.string(),
        (pattern, text) => {
          expect(globMatches(pattern, text)).toBe(pattern === text);
        },
      ),
    );
  });

  it("`*` matches every text, and a pattern matches itself with a `*` in the middle", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (a, b, mid) => {
        const safeA = a.replaceAll("*", "");
        const safeB = b.replaceAll("*", "");
        expect(globMatches("*", a)).toBe(true);
        expect(globMatches(`${safeA}*${safeB}`, `${safeA}${mid}${safeB}`)).toBe(true);
      }),
    );
  });

  it("never throws and stays fast on adversarial input", () => {
    const text = `${"a".repeat(2000)}b`;
    const pattern = `${"a*".repeat(8)}c`;
    const started = performance.now();
    expect(globMatches(pattern, text)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
    fc.assert(
      fc.property(fc.string(), fc.string(), (pattern, text) => {
        expect(typeof globMatches(pattern, text)).toBe("boolean");
      }),
    );
  });
});
