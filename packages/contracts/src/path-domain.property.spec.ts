/**
 * Property tests for the two URL-derived fields that every browser event shares. These fields are
 * where invariant 3 (no query strings or fragments, domain + path only) is enforced at the
 * contract level, so they get generated inputs rather than a handful of examples.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseEvent } from "./index.js";
import { focusSegment, pageVisited } from "./test-helpers.js";

const PAYLOAD_INVALID = { ok: false, code: "ingest.payload_invalid" } as const;

// Path segments: legal pathname characters, no ? and no #, never empty or dot-only.
const segmentArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._~!$&'()*+,;=:@-]{0,29}$/);
const pathArb = fc
  .array(segmentArb, { minLength: 0, maxLength: 6 })
  .map((segments) => `/${segments.join("/")}`);

// A lowercase ASCII hostname: 2-5 labels, each 1-20 chars of [a-z0-9-] not starting or ending with
// a hyphen, and an alphabetic top-level label (so the domain can never be mistaken for an IP).
const labelArb = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])?$/);
const tldArb = fc.stringMatching(/^[a-z]{2,10}$/);
const domainArb = fc
  .tuple(fc.array(labelArb, { minLength: 1, maxLength: 4 }), tldArb)
  .map(([labels, tld]) => [...labels, tld].join("."));

// One UTF-16 surrogate code unit. Inserted into an ASCII path it is always unpaired.
const surrogateArb = fc
  .integer({ min: 0xd800, max: 0xdfff })
  .map((unit) => String.fromCharCode(unit));

// Any code point that is not ?, #, a control character or a surrogate: always fine in a path.
const wellFormedCharArb = fc
  .integer({ min: 0xa0, max: 0x10ffff })
  .filter((cp) => cp < 0xd800 || cp > 0xdfff)
  .map((cp) => String.fromCodePoint(cp));

// Code units with no ?, # or control character, biased toward surrogates so that proper pairs,
// lone halves and reversed pairs all come up.
const unitArb = fc.oneof(
  fc.integer({ min: 0xd800, max: 0xdbff }), // high surrogate
  fc.integer({ min: 0xdc00, max: 0xdfff }), // low surrogate
  fc.constantFrom(0x61, 0x2f, 0x2d, 0xe9, 0x4e2d, 0xfffd), // a / - é 中 U+FFFD
);
const unitsArb = fc.array(unitArb, { maxLength: 12 }).map((units) => String.fromCharCode(...units));

/**
 * `String#isWellFormed()` (ES2024, outside this package's lib), written out as the test oracle:
 * every surrogate code unit is the high or low half of a high-then-low pair.
 */
function isWellFormedUtf16(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    }
  }
  return true;
}

const eventBuilders: [string, (data: Record<string, unknown>) => Record<string, unknown>][] = [
  ["browser.page_visited", (data) => pageVisited(data)],
  ["browser.focus_segment", (data) => focusSegment(data)],
];

describe.each(eventBuilders)("%s: path and domain properties", (_type, build) => {
  it("accepts every generated path that contains no ? and no #", () => {
    fc.assert(
      fc.property(pathArb, (path) => {
        expect(parseEvent(build({ path })).ok).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects every string that contains a ? or a # anywhere, whatever surrounds it", () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom("?", "#"), fc.string(), (before, mark, after) => {
        expect(parseEvent(build({ path: `${before}${mark}${after}` }))).toMatchObject(
          PAYLOAD_INVALID,
        );
      }),
      { numRuns: 300 },
    );
  });

  it("rejects a valid path with a query or fragment appended", () => {
    fc.assert(
      fc.property(pathArb, fc.constantFrom("?", "#"), segmentArb, (path, mark, tail) => {
        expect(parseEvent(build({ path: `${path}${mark}${tail}` }))).toMatchObject(PAYLOAD_INVALID);
      }),
      { numRuns: 200 },
    );
  });

  // Postgres jsonb refuses an unpaired surrogate escape, so letting one through would fail the
  // whole batch's insert instead of rejecting one item.
  it("rejects a valid path once a lone UTF-16 surrogate is inserted anywhere after the leading /", () => {
    fc.assert(
      fc.property(pathArb, surrogateArb, fc.nat(), (path, lone, pick) => {
        const at = 1 + (pick % path.length);
        const poisoned = `${path.slice(0, at)}${lone}${path.slice(at)}`;
        expect(parseEvent(build({ path: poisoned }))).toMatchObject(PAYLOAD_INVALID);
      }),
      { numRuns: 300 },
    );
  });

  it("accepts a path of non-control characters exactly when it is well-formed UTF-16", () => {
    fc.assert(
      fc.property(unitsArb, (tail) => {
        const path = `/${tail}`;
        expect(parseEvent(build({ path })).ok).toBe(isWellFormedUtf16(path));
      }),
      { numRuns: 500 },
    );
  });

  it("accepts a valid path with any well-formed non-control code point inserted, astral ones included", () => {
    fc.assert(
      fc.property(pathArb, wellFormedCharArb, fc.nat(), (path, char, pick) => {
        const at = 1 + (pick % path.length);
        const extended = `${path.slice(0, at)}${char}${path.slice(at)}`;
        expect(parseEvent(build({ path: extended })).ok).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("accepts every generated lowercase ASCII hostname", () => {
    fc.assert(
      fc.property(domainArb, (domain) => {
        fc.pre(domain.length <= 253);
        expect(parseEvent(build({ domain })).ok).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects a valid hostname once any letter in it is upper-cased", () => {
    fc.assert(
      fc.property(domainArb, fc.nat(), (domain, pick) => {
        const letters = [...domain].flatMap((ch, i) => (/[a-z]/.test(ch) ? [i] : []));
        const at = letters[pick % letters.length] as number;
        const mixed = `${domain.slice(0, at)}${domain[at]?.toUpperCase()}${domain.slice(at + 1)}`;
        expect(parseEvent(build({ domain: mixed }))).toMatchObject(PAYLOAD_INVALID);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects a valid hostname once a character outside [a-z0-9.-] is inserted", () => {
    const badChars = ["/", ":", " ", "@", "?", "#", "%", "*", "\\", "\n", "\t", "ü", "中"];
    fc.assert(
      fc.property(domainArb, fc.constantFrom(...badChars), fc.nat(), (domain, bad, pick) => {
        const at = pick % (domain.length + 1);
        const poisoned = `${domain.slice(0, at)}${bad}${domain.slice(at)}`;
        expect(parseEvent(build({ domain: poisoned }))).toMatchObject(PAYLOAD_INVALID);
      }),
      { numRuns: 300 },
    );
  });
});
