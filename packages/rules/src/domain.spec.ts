import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { domainMatches } from "./domain.js";

const label = fc.stringMatching(/^[a-z0-9]{1,10}$/);
const host = fc.array(label, { minLength: 2, maxLength: 4 }).map((parts) => parts.join("."));

describe("domainMatches", () => {
  it.each([
    ["youtube.com", "youtube.com", true],
    ["youtube.com", "www.youtube.com", false],
    ["youtube.com", "notyoutube.com", false],
    ["*.youtube.com", "www.youtube.com", true],
    ["*.youtube.com", "a.b.youtube.com", true],
    ["*.youtube.com", "youtube.com", false],
    ["*.youtube.com", "notyoutube.com", false],
    ["*.youtube.com", "youtube.com.evil.com", false],
  ])("%s vs %s is %s", (pattern, domain, expected) => {
    expect(domainMatches(pattern, domain)).toBe(expected);
  });

  it("a bare domain matches itself and nothing else (property)", () => {
    fc.assert(
      fc.property(host, host, (a, b) => {
        expect(domainMatches(a, a)).toBe(true);
        expect(domainMatches(a, b)).toBe(a === b);
      }),
    );
  });

  it("a wildcard matches every subdomain and never the apex (property)", () => {
    fc.assert(
      fc.property(host, label, (apex, sub) => {
        expect(domainMatches(`*.${apex}`, `${sub}.${apex}`)).toBe(true);
        expect(domainMatches(`*.${apex}`, apex)).toBe(false);
      }),
    );
  });
});
