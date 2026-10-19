import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { globToLike, restrictionConditions } from "./events.repository";

describe("globToLike", () => {
  it("escapes _ (a LIKE wildcard) and turns * into %", () => {
    expect(globToLike("browser.*")).toBe("browser.%");
    expect(globToLike("a_b*")).toBe("a\\_b%");
    expect(globToLike("*.page_visited")).toBe("%.page\\_visited");
  });

  it.each(["", "a b", "A", "a%b", "a'b", "a\\b", "a?"])("refuses %j", (pattern) => {
    expect(() => globToLike(pattern)).toThrow();
  });
});

describe("restrictionConditions", () => {
  const render = (conditions: Array<Parameters<PgDialect["sqlToQuery"]>[0]>) =>
    conditions.map((c) => new PgDialect().sqlToQuery(c));

  it("is empty when the key has no restriction", () => {
    expect(restrictionConditions(undefined, undefined)).toEqual([]);
  });

  it("an empty type list matches nothing, never everything", () => {
    const conditions = restrictionConditions(undefined, []);
    expect(conditions).toHaveLength(1);
    expect(conditions.every((c) => c !== undefined)).toBe(true);
    expect(render(conditions)[0]?.sql).toBe("false");
  });

  it("an empty source list matches nothing too", () => {
    const [condition] = render(restrictionConditions([], undefined));
    expect(condition?.sql).toBe("false");
  });
});
