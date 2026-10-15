import { domainSchema, pathSchema } from "@personal-api/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_URL_INPUT_LENGTH, sanitizeUrl } from "../lib/sanitize-url";

// M2-03: invariant 3. The output never contains `?` or `#`, only http(s) is kept, and the
// result always satisfies the contracts' page_visited domain and path schemas.

const NON_HTTP = [
  "chrome://settings/passwords",
  "edge://settings",
  "about:blank",
  "about:preferences#privacy",
  "moz-extension://abc123/popup.html",
  "chrome-extension://abcdefghijklmnop/popup.html",
  "file:///C:/Users/me/secret.txt",
  "javascript:alert(1)",
  "data:text/html,<h1>x</h1>",
  "blob:https://example.com/3a1b",
  "ftp://example.com/file",
  "view-source:https://example.com/",
  "ws://example.com/socket",
  "mailto:me@example.com",
];

describe("sanitizeUrl: schemes", () => {
  it.each(NON_HTTP)("ignores %s", (url) => {
    expect(sanitizeUrl(url)).toBeNull();
  });

  it.each(["HTTP://Example.com/a", "HTTPS://example.com/a"])("accepts the scheme in %s", (url) => {
    expect(sanitizeUrl(url)).toEqual({ domain: "example.com", path: "/a" });
  });
});

describe("sanitizeUrl: kept parts", () => {
  it.each([
    ["https://example.com", "example.com", "/"],
    ["https://example.com/", "example.com", "/"],
    ["https://example.com?a=1", "example.com", "/"],
    ["https://example.com#frag", "example.com", "/"],
    ["https://github.com/Mohaned178/IdentiK", "github.com", "/Mohaned178/IdentiK"],
    ["https://github.com/a/b?tab=readme&secret=1#top", "github.com", "/a/b"],
    ["https://example.com/a?#", "example.com", "/a"],
    ["https://example.com/a#x?y", "example.com", "/a"],
    ["https://EXAMPLE.Com/Path", "example.com", "/Path"],
    ["https://example.com./a", "example.com", "/a"],
    ["https://user:pass@example.com/a", "example.com", "/a"],
    ["https://user@example.com/a", "example.com", "/a"],
    ["https://example.com:8443/a", "example.com", "/a"],
    ["https://example.com:443/a", "example.com", "/a"],
    ["http://example.com:80/a", "example.com", "/a"],
    ["http://localhost:3000/dash", "localhost", "/dash"],
    ["http://127.0.0.1:8080/x", "127.0.0.1", "/x"],
    ["https://bücher.example/straße", "xn--bcher-kva.example", "/stra%C3%9Fe"],
    ["https://münchen.de/", "xn--mnchen-3ya.de", "/"],
    ["https://example.com//a//b", "example.com", "//a//b"],
    ["https://example.com/a/../b/./c", "example.com", "/b/c"],
    ["https://example.com/a%3Fb%23c", "example.com", "/a%3Fb%23c"],
    ["https://example.com/a%3fb", "example.com", "/a%3fb"],
    ["https://example.com/a b", "example.com", "/a%20b"],
    ["https://example.com\\a\\b", "example.com", "/a/b"],
    ["  https://example.com/a  ", "example.com", "/a"],
    ["https:///example.com/a", "example.com", "/a"],
  ])("%s -> %s %s", (url, domain, path) => {
    expect(sanitizeUrl(url)).toEqual({ domain, path });
  });

  it("never decodes percent-encoded characters", () => {
    const result = sanitizeUrl("https://example.com/a%3Fb%23c%2Fd");
    expect(result?.path).toBe("/a%3Fb%23c%2Fd");
  });
});

describe("sanitizeUrl: unusable input is ignored", () => {
  it.each([
    ["an IPv6 literal (not an ASCII hostname for the contract)", "http://[::1]:3000/a"],
    ["a host with an underscore", "https://a_b.example.com/"],
    ["a bare dot host", "http://./a"],
    ["no scheme", "example.com/a"],
    ["a relative path", "/a/b"],
    ["garbage", "not a url at all"],
    ["an empty string", ""],
    ["whitespace", "   "],
  ])("ignores %s", (_name, url) => {
    expect(sanitizeUrl(url)).toBeNull();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", { href: "https://example.com/" }],
    ["an array", ["https://example.com/"]],
    ["a URL object", new URL("https://example.com/")],
  ])("ignores a non-string (%s) without throwing", (_name, value) => {
    expect(sanitizeUrl(value)).toBeNull();
  });

  it("ignores input longer than the cap without parsing it", () => {
    const url = `https://example.com/${"a".repeat(MAX_URL_INPUT_LENGTH)}`;
    expect(sanitizeUrl(url)).toBeNull();
  });

  it("ignores a path longer than the contract allows instead of truncating it", () => {
    expect(sanitizeUrl(`https://example.com/${"a".repeat(3000)}`)).toBeNull();
  });

  it("ignores a host longer than the contract allows", () => {
    const label = "a".repeat(60);
    expect(sanitizeUrl(`https://${[label, label, label, label, label].join(".")}.com/`)).toBeNull();
  });

  it("ignores a lone surrogate input without throwing", () => {
    expect(() => sanitizeUrl("https://example.com/\uD800")).not.toThrow();
  });
});

const hostArb = fc
  .array(fc.stringMatching(/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,10}[a-zA-Z0-9])?$/), {
    minLength: 1,
    maxLength: 4,
  })
  .map((labels) => `${labels.join(".")}.com`);
const segmentArb = fc
  .string({ unit: "grapheme", maxLength: 12 })
  .map((s) => s.replace(/[?#]/g, ""));
const pathArb = fc
  .array(segmentArb, { maxLength: 5 })
  .map((parts) => parts.map((p) => `/${p}`).join(""));
const queryArb = fc.string({ maxLength: 40 });
const fragmentArb = fc.string({ maxLength: 40 });

function assertValid(result: { domain: string; path: string }) {
  expect(domainSchema.safeParse(result.domain).success).toBe(true);
  expect(pathSchema.safeParse(result.path).success).toBe(true);
  expect(result.path.startsWith("/")).toBe(true);
  expect(result.path).not.toMatch(/[?#]/);
  expect(result.domain).not.toMatch(/[?#@:/\s]/);
}

describe("sanitizeUrl: properties", () => {
  it("never throws and never leaks ? or # for arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 300 }), (input) => {
        const result = sanitizeUrl(input);
        if (result) assertValid(result);
      }),
      { numRuns: 2000 },
    );
  });

  it("never throws on arbitrary values of any type", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const result = sanitizeUrl(input);
        if (result) assertValid(result);
      }),
      { numRuns: 1000 },
    );
  });

  it("never leaks ? or # for strings that look like http URLs", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("http://", "https://", "HTTPS://"),
        fc.string({ unit: "binary", maxLength: 100 }),
        (scheme, rest) => {
          const result = sanitizeUrl(scheme + rest);
          if (result) assertValid(result);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("never leaks ? or # for arbitrary web URLs (query, fragment, userinfo, ports)", () => {
    fc.assert(
      fc.property(
        fc.webUrl({
          withQueryParameters: true,
          withFragments: true,
          authoritySettings: { withUserInfo: true, withPort: true },
          validSchemes: ["http", "https"],
        }),
        (url) => {
          const result = sanitizeUrl(url);
          if (result) assertValid(result);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("drops any query and fragment: the result equals that of the bare URL", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("http", "https"),
        hostArb,
        pathArb,
        queryArb,
        fragmentArb,
        (scheme, host, path, query, fragment) => {
          const bare = sanitizeUrl(`${scheme}://${host}${path}`);
          const full = sanitizeUrl(`${scheme}://${host}${path}?${query}#${fragment}`);
          const onlyQuery = sanitizeUrl(`${scheme}://${host}${path}?${query}`);
          const onlyFragment = sanitizeUrl(`${scheme}://${host}${path}#${fragment}`);
          expect(bare).not.toBeNull();
          expect(full).toEqual(bare);
          expect(onlyQuery).toEqual(bare);
          expect(onlyFragment).toEqual(bare);
          if (full) assertValid(full);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("lowercases the domain and ignores userinfo and port", () => {
    fc.assert(
      fc.property(
        hostArb,
        pathArb,
        fc.integer({ min: 1, max: 65535 }),
        fc.stringMatching(/^[a-z0-9]{1,8}$/),
        (host, path, port, user) => {
          const plain = sanitizeUrl(`https://${host.toLowerCase()}${path}`);
          const noisy = sanitizeUrl(`https://${user}:${user}@${host.toUpperCase()}:${port}${path}`);
          expect(noisy).toEqual(plain);
          expect(noisy?.domain).toBe(noisy?.domain.toLowerCase());
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("is idempotent: sanitizing the rebuilt https URL gives the same pair", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.webUrl({
            withQueryParameters: true,
            withFragments: true,
            validSchemes: ["http", "https"],
          }),
          fc.string({ unit: "binary", maxLength: 100 }).map((s) => `https://example.com/${s}`),
        ),
        (url) => {
          const first = sanitizeUrl(url);
          if (!first) return;
          expect(sanitizeUrl(`https://${first.domain}${first.path}`)).toEqual(first);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("always ignores non-http(s) schemes, whatever follows", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "chrome://",
          "edge://",
          "about:",
          "moz-extension://",
          "chrome-extension://",
          "file://",
          "javascript:",
          "data:",
          "blob:",
          "ftp://",
          "view-source:",
          "ws://",
        ),
        fc.string({ unit: "binary", maxLength: 100 }),
        (scheme, rest) => {
          expect(sanitizeUrl(scheme + rest)).toBeNull();
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("ignores any other scheme made of letters", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9+.-]{0,10}$/).filter((s) => s !== "http" && s !== "https"),
        fc.webUrl({ withQueryParameters: true, withFragments: true }),
        (scheme, url) => {
          expect(sanitizeUrl(url.replace(/^https?/, scheme))).toBeNull();
        },
      ),
      { numRuns: 500 },
    );
  });
});
