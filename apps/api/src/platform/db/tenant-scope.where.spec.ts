/**
 * M1-03 (builder): the scope condition itself, rendered to SQL without a database. Drizzle's
 * `and()` does not parenthesize its operands, so the helper must wrap the caller's `where`, or a
 * raw `sql\`a or b\`` would bind looser than the user_id check and widen the scope.
 */
import { eq, or, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { events, user } from "./schema";
import { MissingUserScopeError, scopeCondition, TenantScopeViolationError } from "./tenant-scope";

const render = (condition: ReturnType<typeof scopeCondition>) =>
  new PgDialect().sqlToQuery(condition);

describe("scopeCondition", () => {
  it("is just user_id = $1 when no where is given, with the user id as a bound parameter", () => {
    const query = render(scopeCondition(events, "user-1"));
    expect(query.sql).toBe('"events"."user_id" = $1');
    expect(query.params).toEqual(["user-1"]);
  });

  it("parenthesizes a raw where with a top-level OR so it cannot escape the scope", () => {
    const query = render(scopeCondition(events, "user-1", sql`true or true`));
    expect(query.sql).toBe('"events"."user_id" = $1 and (true or true)');
    expect(query.params).toEqual(["user-1"]);
  });

  it("keeps the scope first and the caller's parameters after it", () => {
    const query = render(
      scopeCondition(events, "user-1", or(eq(events.userId, "user-2"), eq(events.id, "x"))),
    );
    expect(query.sql.startsWith('"events"."user_id" = $1 and (')).toBe(true);
    expect(query.sql.endsWith(")")).toBe(true);
    expect(query.params).toEqual(["user-1", "user-2", "x"]);
  });

  it("never inlines the user id into the SQL text", () => {
    const hostile = "x' or '1'='1";
    const query = render(scopeCondition(events, hostile));
    expect(query.sql).not.toContain(hostile);
    expect(query.params).toEqual([hostile]);
  });

  it("refuses a missing user id and a table without user_id", () => {
    expect(() => scopeCondition(events, "")).toThrow(MissingUserScopeError);
    expect(() => scopeCondition(user as never, "user-1")).toThrow(TenantScopeViolationError);
  });
});
