import { describe, expect, it } from "vitest";
import {
  endpointInputSchema,
  endpointSlugSchema,
  replaceEndpointRequestSchema,
} from "./endpoints.js";

const definition = {
  when: {},
  window: { kind: "today" },
  aggregate: "count_by_day",
};

describe("endpointSlugSchema", () => {
  it.each(["a", "my-stats", "stats-2", "a1"])("accepts %s", (slug) => {
    expect(endpointSlugSchema.safeParse(slug).success).toBe(true);
  });

  it.each(["", "-a", "a-", "A", "a_b", "a b", "a/b", "../x", "a.b", "é", "a".repeat(41)])(
    "rejects %j",
    (slug) => {
      expect(endpointSlugSchema.safeParse(slug).success).toBe(false);
    },
  );
});

describe("replaceEndpointRequestSchema", () => {
  it("needs enabled, so a replacement can never re-enable an endpoint by omission", () => {
    expect(replaceEndpointRequestSchema.safeParse({ slug: "stats", definition }).success).toBe(
      false,
    );
    for (const enabled of [true, false]) {
      const parsed = replaceEndpointRequestSchema.parse({ slug: "stats", enabled, definition });
      expect(parsed.enabled).toBe(enabled);
    }
  });

  it("rejects unknown keys such as userId or id", () => {
    for (const extra of [{ userId: "u" }, { id: "x" }]) {
      expect(
        replaceEndpointRequestSchema.safeParse({
          slug: "stats",
          enabled: true,
          definition,
          ...extra,
        }).success,
      ).toBe(false);
    }
  });
});

describe("endpointInputSchema", () => {
  it("defaults enabled to true", () => {
    const parsed = endpointInputSchema.parse({ slug: "stats", definition });
    expect(parsed.enabled).toBe(true);
  });

  it("rejects unknown keys such as userId or id", () => {
    expect(endpointInputSchema.safeParse({ slug: "stats", definition, userId: "u" }).success).toBe(
      false,
    );
    expect(endpointInputSchema.safeParse({ slug: "stats", definition, id: "x" }).success).toBe(
      false,
    );
  });

  it("rejects an invalid definition", () => {
    expect(
      endpointInputSchema.safeParse({
        slug: "stats",
        definition: { ...definition, fields: ["type"] },
      }).success,
    ).toBe(false);
  });
});
