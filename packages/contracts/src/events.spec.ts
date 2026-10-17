import { describe, expect, it } from "vitest";
import {
  deleteEventsRequestSchema,
  EVENTS_DELETE_MAX_IDS,
  EVENTS_MAX_LIMIT,
  listEventsQuerySchema,
  storedEventSchema,
} from "./events.js";

const ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";

describe("listEventsQuerySchema", () => {
  it("accepts no filter and every filter", () => {
    expect(listEventsQuerySchema.parse({})).toEqual({});
    expect(
      listEventsQuerySchema.parse({
        source: ID,
        type: "browser.page_visited",
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-02T00:00:00.000Z",
        domain: "github.com",
        cursor: "abc",
        limit: "25",
      }),
    ).toMatchObject({ source: ID, domain: "github.com", limit: 25 });
  });

  it.each([
    ["userId", { userId: ID }],
    ["integrationId", { integrationId: ID }],
    ["unknown key", { page: "2" }],
    ["offset", { offset: "10" }],
    ["non-uuid source", { source: "x" }],
    ["empty type", { type: "" }],
    ["offset date", { from: "2026-10-01T00:00:00+02:00" }],
    ["uppercase domain", { domain: "GitHub.com" }],
    ["url as domain", { domain: "https://github.com/x" }],
    ["limit 0", { limit: "0" }],
    ["limit over max", { limit: String(EVENTS_MAX_LIMIT + 1) }],
    ["limit not a number", { limit: "ten" }],
    ["repeated type", { type: ["a", "b"] }],
  ])("rejects %s", (_label, query) => {
    expect(listEventsQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe("deleteEventsRequestSchema", () => {
  it("accepts 1 to the max ids", () => {
    expect(deleteEventsRequestSchema.parse({ ids: [ID] })).toEqual({ ids: [ID] });
    const many = Array.from({ length: EVENTS_DELETE_MAX_IDS }, () => ID);
    expect(deleteEventsRequestSchema.safeParse({ ids: many }).success).toBe(true);
  });

  it.each([
    ["no ids", { ids: [] }],
    ["too many", { ids: Array.from({ length: EVENTS_DELETE_MAX_IDS + 1 }, () => ID) }],
    ["non-uuid", { ids: ["1 or 1=1"] }],
    ["missing", {}],
    ["a filter", { ids: [ID], type: "x" }],
    ["userId", { ids: [ID], userId: ID }],
  ])("rejects %s", (_label, body) => {
    expect(deleteEventsRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("storedEventSchema", () => {
  it("rejects an unexpected field (no accidental column leak)", () => {
    const event = {
      id: ID,
      integrationId: ID,
      type: "browser.page_visited",
      typeVersion: 1,
      occurredAt: "2026-10-01T00:00:00.000Z",
      receivedAt: "2026-10-01T00:00:01.000Z",
      origin: "collected",
      data: { domain: "github.com" },
      tags: [],
    };
    expect(storedEventSchema.safeParse(event).success).toBe(true);
    expect(storedEventSchema.safeParse({ ...event, userId: ID }).success).toBe(false);
  });
});
