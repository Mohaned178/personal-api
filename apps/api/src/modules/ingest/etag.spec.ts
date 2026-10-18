import { describe, expect, it } from "vitest";
import { etagOf, ifNoneMatchHits } from "./etag";

describe("etagOf", () => {
  it("is quoted, URL-safe and stable for equal bodies", () => {
    const tag = etagOf({ a: 1, b: [2] });
    expect(tag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    expect(etagOf({ a: 1, b: [2] })).toBe(tag);
  });

  it("differs when the body differs", () => {
    expect(etagOf({ a: 1 })).not.toBe(etagOf({ a: 2 }));
  });
});

describe("ifNoneMatchHits", () => {
  const tag = '"abc"';

  it.each([
    ["the same tag", '"abc"'],
    ["a weak form", 'W/"abc"'],
    ["a list with spaces", '"x",  "abc" , "y"'],
    ["a star", "*"],
  ])("matches %s", (_label, header) => {
    expect(ifNoneMatchHits(header, tag)).toBe(true);
  });

  it.each([
    ["no header", undefined],
    ["an empty header", ""],
    ["another tag", '"abd"'],
    ["an unquoted lookalike", "abc"],
    ["only separators", " , ,"],
  ])("does not match %s", (_label, header) => {
    expect(ifNoneMatchHits(header, tag)).toBe(false);
  });
});
