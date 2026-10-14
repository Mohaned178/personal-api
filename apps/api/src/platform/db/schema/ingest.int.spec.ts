import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "../../../../test/postgres";
import { apiKeys, events, ingestionLog, integrations, user } from ".";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb?.stop();
});

async function seedUser(id: string) {
  await testDb.db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  const [integration] = await testDb.db
    .insert(integrations)
    .values({ userId: id, kind: "http", name: "test" })
    .returning();
  if (!integration) throw new Error("integration not created");
  return integration;
}

const eventValues = (userId: string, integrationId: string, clientEventId: string) => ({
  userId,
  integrationId,
  clientEventId,
  type: "browser.page_visited",
  typeVersion: 1,
  occurredAt: new Date("2026-10-13T10:05:00.000Z"),
  data: { domain: "example.test", path: "/" },
});

describe("ingest schema (Testcontainers)", () => {
  it("defaults integrations.default_policy to deny", async () => {
    const integration = await seedUser("u-default");
    expect(integration.defaultPolicy).toBe("deny");
    expect(integration.status).toBe("active");
  });

  it("makes a duplicate (user, integration, client_event_id) insert a no-op", async () => {
    const integration = await seedUser("u-dedupe");
    const values = eventValues("u-dedupe", integration.id, "evt-1");
    const first = await testDb.db.insert(events).values(values).onConflictDoNothing().returning();
    const second = await testDb.db.insert(events).values(values).onConflictDoNothing().returning();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    const rows = await testDb.db.select().from(events).where(eq(events.userId, "u-dedupe"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clientOccurredAt).toBeNull();
    expect(rows[0]?.trace).toBeNull();
    expect(rows[0]?.expiresAt).toBeNull();
  });

  it("rejects an ingest key without an integration, accepts a read key without one", async () => {
    await seedUser("u-keys");
    const base = { userId: "u-keys", prefix: "pa_ing_abcd", scopes: [] };
    await expect(
      testDb.db.insert(apiKeys).values({ ...base, kind: "ingest", hash: "h-ingest-null" }),
    ).rejects.toThrow();
    await expect(
      testDb.db
        .insert(apiKeys)
        .values({ ...base, kind: "read", prefix: "pa_read_abcd", hash: "h-read-null" }),
    ).resolves.toBeDefined();
  });

  it("enforces unique api key hashes", async () => {
    const integration = await seedUser("u-hash");
    const key = {
      userId: "u-hash",
      kind: "ingest",
      integrationId: integration.id,
      prefix: "pa_ing_abcd",
      hash: "same-hash",
    };
    await testDb.db.insert(apiKeys).values(key);
    await expect(testDb.db.insert(apiKeys).values(key)).rejects.toThrow();
  });

  it("enforces one ingestion_log row per (user, integration, bucket)", async () => {
    const integration = await seedUser("u-log");
    const row = {
      userId: "u-log",
      integrationId: integration.id,
      bucket: new Date("2026-10-13T10:00:00.000Z"),
    };
    await testDb.db.insert(ingestionLog).values(row);
    await expect(testDb.db.insert(ingestionLog).values(row)).rejects.toThrow();
  });

  it("cascades deletes from user to every tenant table", async () => {
    const integration = await seedUser("u-cascade");
    await testDb.db.insert(events).values(eventValues("u-cascade", integration.id, "evt-1"));
    await testDb.db.insert(apiKeys).values({
      userId: "u-cascade",
      kind: "ingest",
      integrationId: integration.id,
      prefix: "pa_ing_abcd",
      hash: "h-cascade",
    });
    await testDb.db.insert(ingestionLog).values({
      userId: "u-cascade",
      integrationId: integration.id,
      bucket: new Date("2026-10-13T10:00:00.000Z"),
    });

    await testDb.db.delete(user).where(eq(user.id, "u-cascade"));

    for (const table of [integrations, apiKeys, events, ingestionLog]) {
      const rows = await testDb.db.select().from(table).where(eq(table.userId, "u-cascade"));
      expect(rows).toHaveLength(0);
    }
  });
});
