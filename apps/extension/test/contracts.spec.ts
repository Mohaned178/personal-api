import { parseEvent } from "@personal-api/contracts";
import { describe, expect, it } from "vitest";

// M1-01: the extension (ESM, bundled by WXT) imports @personal-api/contracts from its built dist.

const validEvent = {
  id: "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b",
  type: "browser.page_visited",
  typeVersion: 1,
  occurredAt: "2026-10-13T10:05:00.000Z",
  data: {
    domain: "github.com",
    path: "/Mohaned178/IdentiK",
    transition: "link",
    tabRef: "k3j2h1g4f5d6a7b8",
  },
  meta: { ruleSetVersion: 7, client: "pa-extension/0.1.0" },
};

describe("@personal-api/contracts in apps/extension", () => {
  it("parses a valid event", () => {
    expect(parseEvent(validEvent).ok).toBe(true);
  });

  it("rejects a path that carries a query string with ingest.payload_invalid", () => {
    const withQuery = { ...validEvent, data: { ...validEvent.data, path: "/search?q=secret" } };
    expect(parseEvent(withQuery)).toMatchObject({ ok: false, code: "ingest.payload_invalid" });
  });
});
