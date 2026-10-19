import { describe, expect, it } from "vitest";
import {
  deleteEventsBodySchema,
  deleteEventsByFilterRequestSchema,
  deletionSchema,
} from "./deletions.js";

const ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";

describe("deleteEventsByFilterRequestSchema", () => {
  it("accepts any one filter field or all of them", () => {
    for (const filter of [
      { source: ID },
      { type: "browser.page_visited" },
      { domain: "example.com" },
      { from: "2026-10-01T00:00:00.000Z" },
      { source: ID, type: "browser.*".replace("*", "tab_opened"), to: "2026-10-02T00:00:00.000Z" },
    ]) {
      expect(
        deleteEventsByFilterRequestSchema.safeParse({ filter }).success,
        JSON.stringify(filter),
      ).toBe(true);
    }
  });

  it("rejects an empty filter, unknown keys and a user id anywhere", () => {
    for (const body of [
      { filter: {} },
      { filter: { source: ID, userId: "u" } },
      { filter: { source: ID }, userId: "u" },
      { filter: { source: "nope" } },
      { filter: { cursor: "x", source: ID } },
      {},
    ]) {
      expect(deleteEventsByFilterRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
  });
});

describe("deleteEventsBodySchema", () => {
  it("accepts ids or a filter, never both", () => {
    expect(deleteEventsBodySchema.safeParse({ ids: [ID] }).success).toBe(true);
    expect(deleteEventsBodySchema.safeParse({ filter: { source: ID } }).success).toBe(true);
    expect(deleteEventsBodySchema.safeParse({ ids: [ID], filter: { source: ID } }).success).toBe(
      false,
    );
  });
});

describe("deletionSchema", () => {
  it("round-trips a running deletion and refuses extra fields", () => {
    const deletion = {
      id: ID,
      kind: "events",
      status: "running",
      total: null,
      deleted: 0,
      createdAt: "2026-10-19T10:00:00.000Z",
      finishedAt: null,
    };
    expect(deletionSchema.parse(deletion)).toEqual(deletion);
    expect(deletionSchema.safeParse({ ...deletion, userId: "u" }).success).toBe(false);
  });
});
