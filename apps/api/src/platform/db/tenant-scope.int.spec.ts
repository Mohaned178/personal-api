/**
 * M1-03 tenant-scoped repository helper against a real database (Testcontainers; CI runs these,
 * Docker may be off locally). User A's scope must never read, change or delete user B's rows, no
 * matter what `where` it is handed.
 */
import { and, eq, or, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { events, integrations, user } from "./schema";
import { MissingUserScopeError, tenantScope } from "./tenant-scope";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
}, 180_000);

afterAll(async () => {
  await testDb?.stop();
});

interface Seeded {
  userId: string;
  integrationId: string;
  eventIds: string[];
}

let counter = 0;

/** Two isolated tenants, seeded with raw inserts (the helper under test is not used to seed). */
async function seedTwoTenants(): Promise<{ a: Seeded; b: Seeded }> {
  counter += 1;
  const seed = async (label: string): Promise<Seeded> => {
    const userId = `ts-${label}-${counter}`;
    await testDb.db
      .insert(user)
      .values({ id: userId, name: userId, email: `${userId}@example.test` });
    const [integration] = await testDb.db
      .insert(integrations)
      .values({ userId, kind: "http", name: `integration-${label}` })
      .returning();
    if (!integration) throw new Error("integration not created");
    const rows = await testDb.db
      .insert(events)
      .values(
        [1, 2].map((n) => ({
          userId,
          integrationId: integration.id,
          clientEventId: `${label}-${n}`,
          type: "browser.page_visited",
          typeVersion: 1,
          occurredAt: new Date("2026-10-13T10:05:00.000Z"),
          data: { domain: "example.test", path: "/" },
        })),
      )
      .returning();
    return { userId, integrationId: integration.id, eventIds: rows.map((row) => row.id) };
  };
  return { a: await seed("a"), b: await seed("b") };
}

describe("tenantScope select", () => {
  it("returns only the scope user's rows", async () => {
    const { a, b } = await seedTwoTenants();
    const rows = await tenantScope(testDb.db, a.userId).select(events);
    expect(rows.map((row) => row.id).sort()).toEqual([...a.eventIds].sort());
    expect(rows.every((row) => row.userId === a.userId)).toBe(true);
    expect(rows.some((row) => b.eventIds.includes(row.id))).toBe(false);
  });

  it("returns nothing when the where clause targets another user's row by id", async () => {
    const { a, b } = await seedTwoTenants();
    const [victim] = b.eventIds;
    if (!victim) throw new Error("seed failed");
    const rows = await tenantScope(testDb.db, a.userId).select(events, eq(events.id, victim));
    expect(rows).toEqual([]);
  });

  it("cannot be widened by an OR in the where clause", async () => {
    const { a, b } = await seedTwoTenants();
    const rows = await tenantScope(testDb.db, a.userId).select(
      events,
      or(eq(events.userId, b.userId), sql`true`),
    );
    expect(rows.every((row) => row.userId === a.userId)).toBe(true);
    expect(rows).toHaveLength(a.eventIds.length);
  });

  it("applies the caller's where clause on top of the scope", async () => {
    const { a } = await seedTwoTenants();
    const rows = await tenantScope(testDb.db, a.userId).select(
      events,
      eq(events.clientEventId, "a-1"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clientEventId).toBe("a-1");
  });

  it("returns [] for a user id that owns nothing", async () => {
    await seedTwoTenants();
    expect(await tenantScope(testDb.db, "nobody-owns-this").select(events)).toEqual([]);
  });

  it("keeps interleaved scopes apart (no leakage between concurrent calls)", async () => {
    const { a, b } = await seedTwoTenants();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        tenantScope(testDb.db, i % 2 === 0 ? a.userId : b.userId).select(events),
      ),
    );
    results.forEach((rows, i) => {
      const expected = i % 2 === 0 ? a.userId : b.userId;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.userId === expected)).toBe(true);
    });
  });
});

describe("tenantScope insert", () => {
  it("stamps the scope user's id on the inserted row", async () => {
    const { a } = await seedTwoTenants();
    const [row] = await tenantScope(testDb.db, a.userId).insert(events, {
      integrationId: a.integrationId,
      clientEventId: "inserted-1",
      type: "browser.page_visited",
      typeVersion: 1,
      occurredAt: new Date("2026-10-13T10:06:00.000Z"),
      data: { domain: "example.test", path: "/x" },
    });
    expect(row?.userId).toBe(a.userId);
    const stored = await testDb.db
      .select()
      .from(events)
      .where(eq(events.id, row?.id ?? ""));
    expect(stored[0]?.userId).toBe(a.userId);
  });

  it("inserts several rows at once, all stamped with the scope user", async () => {
    const { a } = await seedTwoTenants();
    const rows = await tenantScope(testDb.db, a.userId).insert(
      events,
      ["m-1", "m-2", "m-3"].map((clientEventId) => ({
        integrationId: a.integrationId,
        clientEventId,
        type: "browser.page_visited",
        typeVersion: 1,
        occurredAt: new Date("2026-10-13T10:06:00.000Z"),
        data: { domain: "example.test", path: "/" },
      })),
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.userId === a.userId)).toBe(true);
  });

  it("rejects a value that carries another user's id, and stores nothing", async () => {
    const { a, b } = await seedTwoTenants();
    const smuggled = {
      userId: b.userId,
      integrationId: b.integrationId,
      clientEventId: "smuggled-1",
      type: "browser.page_visited",
      typeVersion: 1,
      occurredAt: new Date("2026-10-13T10:06:00.000Z"),
      data: { domain: "example.test", path: "/" },
    };
    await expect(
      tenantScope(testDb.db, a.userId).insert(events, smuggled as never),
    ).rejects.toThrow();
    const rows = await testDb.db
      .select()
      .from(events)
      .where(eq(events.clientEventId, "smuggled-1"));
    expect(rows).toEqual([]);
  });
});

describe("tenantScope update", () => {
  it("updates only the scope user's rows when no where is given", async () => {
    const { a, b } = await seedTwoTenants();
    const updated = await tenantScope(testDb.db, a.userId).update(integrations, {
      name: "renamed",
    });
    expect(updated.map((row) => row.id)).toEqual([a.integrationId]);
    const [other] = await testDb.db
      .select()
      .from(integrations)
      .where(eq(integrations.id, b.integrationId));
    expect(other?.name).toBe("integration-b");
  });

  it("cannot update another user's row by id: returns [] and leaves it unchanged", async () => {
    const { a, b } = await seedTwoTenants();
    const updated = await tenantScope(testDb.db, a.userId).update(
      integrations,
      { name: "hijacked", status: "revoked" },
      eq(integrations.id, b.integrationId),
    );
    expect(updated).toEqual([]);
    const [row] = await testDb.db
      .select()
      .from(integrations)
      .where(eq(integrations.id, b.integrationId));
    expect(row).toMatchObject({ name: "integration-b", status: "active" });
  });

  it("rejects a set that tries to move a row to another user", async () => {
    const { a, b } = await seedTwoTenants();
    await expect(
      tenantScope(testDb.db, a.userId).update(integrations, { userId: b.userId } as never),
    ).rejects.toThrow();
    const [row] = await testDb.db
      .select()
      .from(integrations)
      .where(eq(integrations.id, a.integrationId));
    expect(row?.userId).toBe(a.userId);
  });
});

describe("tenantScope delete", () => {
  it("cannot delete another user's row by id: returns [] and the row survives", async () => {
    const { a, b } = await seedTwoTenants();
    const [victim] = b.eventIds;
    if (!victim) throw new Error("seed failed");
    const deleted = await tenantScope(testDb.db, a.userId).delete(events, eq(events.id, victim));
    expect(deleted).toEqual([]);
    const rows = await testDb.db.select().from(events).where(eq(events.id, victim));
    expect(rows).toHaveLength(1);
  });

  it("with no where deletes only the scope user's rows, not everyone's", async () => {
    const { a, b } = await seedTwoTenants();
    const deleted = await tenantScope(testDb.db, a.userId).delete(events);
    expect(deleted).toHaveLength(a.eventIds.length);
    const remainingA = await testDb.db.select().from(events).where(eq(events.userId, a.userId));
    const remainingB = await testDb.db.select().from(events).where(eq(events.userId, b.userId));
    expect(remainingA).toEqual([]);
    expect(remainingB).toHaveLength(b.eventIds.length);
  });

  it("deletes the scope user's own row matched by where", async () => {
    const { a } = await seedTwoTenants();
    const [mine] = a.eventIds;
    if (!mine) throw new Error("seed failed");
    const deleted = await tenantScope(testDb.db, a.userId).delete(events, and(eq(events.id, mine)));
    expect(deleted.map((row) => row.id)).toEqual([mine]);
  });
});

describe("tenantScope on a table without a user_id column", () => {
  it("refuses to run (the better-auth user table is not tenant data)", async () => {
    const { a } = await seedTwoTenants();
    const scope = tenantScope(testDb.db, a.userId);
    await expect(Promise.resolve().then(() => scope.select(user as never))).rejects.toThrow();
  });
});

describe("tenantScope refuses a missing user scope with a real database", () => {
  it("throws MissingUserScopeError for an empty userId", () => {
    expect(() => tenantScope(testDb.db, "")).toThrow(MissingUserScopeError);
  });
});
