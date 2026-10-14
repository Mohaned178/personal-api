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
