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

  it("stays fast on the worst case a rule set can hold (M4-R S1)", () => {
    // 100 rules x 20 `matches_glob` conditions is 2000 evaluations of one 2 KB path.
    const text = "a".repeat(2000);
    const pattern = `*${"a".repeat(254)}b`;
    // Only the matcher is timed: an `expect` per call made the test measure Vitest's assertion
    // overhead, which flaked on Windows runners (265 and 486 ms; the matching itself is ~1 ms).
    const results: boolean[] = [];
    const started = performance.now();
    for (let i = 0; i < 2000; i++) results.push(globMatches(pattern, text));
    const elapsed = performance.now() - started;
    expect(results.every((matched) => matched === false)).toBe(true);
    expect(elapsed).toBeLessThan(250);
  });

  it("stays fast when the pieces between the stars are searched too (M4-R S1)", () => {
    const text = "a".repeat(2000);
    const piece = `${"a".repeat(120)}b`;
    for (const pattern of [`*${piece}*`, `*${piece}*${piece}*`, `a*${piece}*${piece}*a`]) {
      const results: boolean[] = [];
      const started = performance.now();
      for (let i = 0; i < 200; i++) results.push(globMatches(pattern, text));
      const elapsed = performance.now() - started;
      expect(results.every((matched) => matched === false)).toBe(true);
      expect(elapsed).toBeLessThan(250);
    }
  });

  it("agrees with a plain dynamic-programming matcher", () => {
    const reference = (pattern: string, text: string): boolean => {
      let row = [true, ...Array<boolean>(text.length).fill(false)];
      for (const ch of pattern) {
        const next = [ch === "*" ? row[0] === true : false];
        for (let j = 1; j <= text.length; j++) {
          next.push(
            ch === "*"
              ? row[j] === true || next[j - 1] === true
              : row[j - 1] === true && text[j - 1] === ch,
          );
        }
        row = next;
      }
      return row[text.length] === true;
    };
    const small = fc.string({ unit: fc.constantFrom("a", "b", "*"), maxLength: 12 });
    const letters = fc.string({ unit: fc.constantFrom("a", "b"), maxLength: 14 });
    fc.assert(
      fc.property(small, letters, (pattern, text) => {
        expect(globMatches(pattern, text)).toBe(reference(pattern, text));
      }),
      { numRuns: 2000 },
    );
  });
});
