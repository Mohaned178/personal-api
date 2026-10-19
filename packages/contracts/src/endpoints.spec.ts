import { describe, expect, it } from "vitest";
import { endpointInputSchema, endpointSlugSchema } from "./endpoints.js";

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
