import { createRequire } from "node:module";
import { parseEvent } from "@personal-api/contracts";
import { describe, expect, it } from "vitest";

// M1-01: the API consumes @personal-api/contracts through its built dist. The API compiles to
// CommonJS, so the package must also load through require(), not only through import.

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

describe("@personal-api/contracts in apps/api", () => {
  it("parses a valid event imported through ESM import", () => {
    const result = parseEvent(validEvent);
    expect(result.ok).toBe(true);
  });

  it("rejects an envelope carrying userId with ingest.envelope_invalid", () => {
    expect(
      parseEvent({ ...validEvent, userId: "11111111-1111-4111-8111-111111111111" }),
    ).toMatchObject({ ok: false, code: "ingest.envelope_invalid" });
  });

  it("loads through require() (CommonJS consumers) and parses the same event", () => {
    const require = createRequire(import.meta.url);
    const contracts = require("@personal-api/contracts") as {
      parseEvent: (input: unknown) => { ok: boolean };
    };
    expect(typeof contracts.parseEvent).toBe("function");
    expect(contracts.parseEvent(validEvent).ok).toBe(true);
  });
});
