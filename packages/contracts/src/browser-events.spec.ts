import { describe, expect, it } from "vitest";
import { parseEvent } from "./index.js";
import { META, OCCURRED_AT, pageVisited, TAB_REF, UUID_V7, withoutKey } from "./test-helpers.js";

function event(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    id: UUID_V7,
    type,
    typeVersion: 1,
    occurredAt: OCCURRED_AT,
    data,
    meta: META,
  };
}

const PAYLOAD_INVALID = { ok: false, code: "ingest.payload_invalid" } as const;

describe("browser.page_visited v1", () => {
  it("accepts an event with the optional transition", () => {
    expect(parseEvent(pageVisited({ transition: "link" })).ok).toBe(true);
  });

  it.each(["start_page", "auto_toplevel"])(
    "accepts the webNavigation/history-only transition %s",
    (transition) => {
      expect(parseEvent(pageVisited({ transition })).ok).toBe(true);
    },
  );

  it("accepts an event without transition (transition is optional)", () => {
    const data = withoutKey(pageVisited().data as Record<string, unknown>, "transition");
    expect(data).not.toHaveProperty("transition");
    expect(parseEvent(event("browser.page_visited", data)).ok).toBe(true);
  });

  it.each([
    ["a number", 123],
    ["null", null],
    ["an object", { kind: "link" }],
  ])("rejects transition given as %s with ingest.payload_invalid", (_name, transition) => {
    expect(parseEvent(pageVisited({ transition }))).toMatchObject(PAYLOAD_INVALID);
  });

  it.each(["domain", "path"])("rejects data missing %s with ingest.payload_invalid", (field) => {
    const event1 = pageVisited();
    const data = withoutKey(event1.data as Record<string, unknown>, field);
    expect(parseEvent({ ...event1, data })).toMatchObject(PAYLOAD_INVALID);
  });

  it.each([
    ["title", { title: "Inbox (3) - Gmail" }],
    ["url", { url: "https://github.com/a/b?token=1" }],
    ["query", { query: "token=1" }],
    ["referrer", { referrer: "https://example.com/" }],
    ["userId", { userId: "11111111-1111-4111-8111-111111111111" }],
    ["integrationId", { integrationId: "22222222-2222-4222-8222-222222222222" }],
    ["receivedAt", { receivedAt: "2026-10-13T10:05:01.000Z" }],
    ["origin", { origin: "collected" }],
    ["an arbitrary unknown key", { extra: true }],
  ])("rejects an unknown key in data (%s) with ingest.payload_invalid", (_name, extra) => {
    expect(parseEvent(pageVisited(extra))).toMatchObject(PAYLOAD_INVALID);
  });

  it.each([
    ["a string", "github.com"],
    ["an array", []],
    ["null", null],
  ])("rejects data given as %s (never accepted)", (_name, data) => {
    const result = parseEvent(pageVisited({}, { data }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["ingest.envelope_invalid", "ingest.payload_invalid"]).toContain(result.code);
  });

  describe("path", () => {
    it.each([["/"], ["/a"], ["/Mohaned178/IdentiK"], ["/a/b/c.html"], ["/a%20b/c%3Fd%23e"]])(
      "accepts the path %s",
      (path) => {
        expect(parseEvent(pageVisited({ path })).ok).toBe(true);
      },
    );

    it.each([
      ["a query string", "/search?q=secret"],
      ["a bare question mark", "/search?"],
      ["a fragment", "/docs#install"],
      ["a bare hash", "/docs#"],
      ["a query and a fragment", "/a?b=1#c"],
      ["only a query", "?q=1"],
      ["only a fragment", "#top"],
    ])("rejects a path with %s with ingest.payload_invalid", (_name, path) => {
      expect(parseEvent(pageVisited({ path }))).toMatchObject(PAYLOAD_INVALID);
    });

    it.each([
      ["a number", 5],
      ["null", null],
      ["an array", ["/a"]],
    ])("rejects a path given as %s with ingest.payload_invalid", (_name, path) => {
      expect(parseEvent(pageVisited({ path }))).toMatchObject(PAYLOAD_INVALID);
    });

    it("rejects an absurdly long path (1,000,000 characters) with ingest.payload_invalid", () => {
      expect(parseEvent(pageVisited({ path: `/${"a".repeat(1_000_000)}` }))).toMatchObject(
        PAYLOAD_INVALID,
      );
    });
  });

  describe("domain", () => {
    it.each([
      ["github.com"],
      ["docs.google.com"],
      ["a.b.c.d.example.org"],
      ["xn--bcher-kva.example"], // punycode form of bücher.example
      ["example-site.co.uk"],
      ["123.example.com"],
    ])("accepts the domain %s", (domain) => {
      expect(parseEvent(pageVisited({ domain })).ok).toBe(true);
    });

    it.each([
      ["upper case", "GitHub.com"],
      ["non-ASCII (must be punycode)", "bücher.example"],
      ["a path", "example.com/path"],
      ["a scheme", "https://github.com"],
      ["a port", "example.com:8080"],
      ["userinfo", "user@example.com"],
      ["a space", "example .com"],
      ["a wildcard", "*.example.com"],
      ["an empty string", ""],
      ["an empty label", "a..example.com"],
      ["a leading hyphen in a label", "-bad.example.com"],
      ["a trailing hyphen in a label", "bad-.example.com"],
      ["a leading dot", ".example.com"],
      ["a newline at the end", "example.com\n"],
      ["a query", "example.com?x=1"],
      ["a fragment", "example.com#x"],
    ])("rejects a domain with %s with ingest.payload_invalid", (_name, domain) => {
      expect(parseEvent(pageVisited({ domain }))).toMatchObject(PAYLOAD_INVALID);
    });

    it("rejects a label longer than 63 characters with ingest.payload_invalid", () => {
      expect(parseEvent(pageVisited({ domain: `${"a".repeat(64)}.example.com` }))).toMatchObject(
        PAYLOAD_INVALID,
      );
    });

    it("rejects a domain longer than 253 characters with ingest.payload_invalid", () => {
      const label = "a".repeat(60);
      const domain = `${label}.${label}.${label}.${label}.${label}.com`; // 5*61 + 3 = 308
      expect(parseEvent(pageVisited({ domain }))).toMatchObject(PAYLOAD_INVALID);
    });

    it.each([
      ["a number", 5],
      ["null", null],
      ["an array", ["github.com"]],
    ])("rejects a domain given as %s with ingest.payload_invalid", (_name, domain) => {
      expect(parseEvent(pageVisited({ domain }))).toMatchObject(PAYLOAD_INVALID);
    });
  });
});

describe("browser.tab_opened v1 and browser.tab_closed v1", () => {
  it.each(["browser.tab_opened", "browser.tab_closed"])(
    "%s accepts a tabRef with a domain",
    (type) => {
      expect(parseEvent(event(type, { tabRef: TAB_REF, domain: "github.com" })).ok).toBe(true);
    },
  );

  it.each(["browser.tab_opened", "browser.tab_closed"])(
    "%s accepts a tabRef without a domain (domain is optional)",
    (type) => {
      expect(parseEvent(event(type, { tabRef: TAB_REF })).ok).toBe(true);
    },
  );

  it.each(["browser.tab_opened", "browser.tab_closed"])(
    "%s rejects data without a tabRef with ingest.payload_invalid",
    (type) => {
      expect(parseEvent(event(type, { domain: "github.com" }))).toMatchObject(PAYLOAD_INVALID);
    },
  );

  it.each(["browser.tab_opened", "browser.tab_closed"])(
    "%s rejects an upper-case domain with ingest.payload_invalid",
    (type) => {
      expect(parseEvent(event(type, { tabRef: TAB_REF, domain: "GitHub.com" }))).toMatchObject(
        PAYLOAD_INVALID,
      );
    },
  );

  it.each(["browser.tab_opened", "browser.tab_closed"])(
    "%s rejects a path, url or title in data (only tabRef and domain are collected)",
    (type) => {
      for (const extra of [{ path: "/a" }, { url: "https://github.com/a" }, { title: "x" }]) {
        expect(
          parseEvent(event(type, { tabRef: TAB_REF, domain: "github.com", ...extra })),
        ).toMatchObject(PAYLOAD_INVALID);
      }
    },
  );

  it.each(["browser.tab_opened", "browser.tab_closed"])(
    "%s rejects server-owned keys in data with ingest.payload_invalid",
    (type) => {
      for (const key of ["userId", "integrationId", "receivedAt", "origin"]) {
        expect(parseEvent(event(type, { tabRef: TAB_REF, [key]: "x" }))).toMatchObject(
          PAYLOAD_INVALID,
        );
      }
    },
  );
});

describe("browser.session_started v1 and browser.session_ended v1", () => {
  it("browser.session_started accepts the reason startup", () => {
    expect(parseEvent(event("browser.session_started", { reason: "startup" })).ok).toBe(true);
  });

  it.each(["idle", "lock", "shutdown"])("browser.session_ended accepts the reason %s", (reason) => {
    expect(parseEvent(event("browser.session_ended", { reason })).ok).toBe(true);
  });

  it.each(["browser.session_started", "browser.session_ended"])(
    "%s rejects a reason outside startup/idle/lock/shutdown with ingest.payload_invalid",
    (type) => {
      expect(parseEvent(event(type, { reason: "coffee-break" }))).toMatchObject(PAYLOAD_INVALID);
      expect(parseEvent(event(type, { reason: "" }))).toMatchObject(PAYLOAD_INVALID);
      expect(parseEvent(event(type, { reason: 3 }))).toMatchObject(PAYLOAD_INVALID);
    },
  );

  it.each(["browser.session_started", "browser.session_ended"])(
    "%s rejects unknown keys and server-owned keys in data with ingest.payload_invalid",
    (type) => {
      for (const key of ["domain", "userId", "integrationId", "receivedAt", "origin", "extra"]) {
        expect(parseEvent(event(type, { reason: "startup", [key]: "x" }))).toMatchObject(
          PAYLOAD_INVALID,
        );
      }
    },
  );

  it.each(["browser.session_started", "browser.session_ended"])(
    "%s rejects an unregistered typeVersion with ingest.type_version_unknown",
    (type) => {
      expect(parseEvent({ ...event(type, { reason: "startup" }), typeVersion: 2 })).toMatchObject({
        ok: false,
        code: "ingest.type_version_unknown",
      });
    },
  );
});
