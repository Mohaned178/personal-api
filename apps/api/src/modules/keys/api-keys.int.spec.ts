/**
 * M1-03 ApiKeysService against a real database (Testcontainers; CI runs these, Docker may be off
 * locally). Uses the two-user fixture (apps/api/test/two-user-fixture.ts) and a fake clock.
 *
 * Contract (see api-keys.service.ts):
 *  - createIngestKey(userId, integrationId) -> { id, key, prefix }; stores only the SHA-256 hash.
 *  - revokeKey(userId, keyId) -> boolean (false when the key is not that user's).
 *  - authenticateIngestKey(token) -> IngestAuthContext | null (null for ANY bad input, never throws).
 *  - last_used_at is set from the injected clock, at most once per LAST_USED_UPDATE_INTERVAL_MS.
 */
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { buildFixtureApp, type FixtureUser, seedTwoUsers } from "../../../test/two-user-fixture";
import { apiKeys, integrations } from "../../platform/db/schema";
import { MissingUserScopeError, tenantScope } from "../../platform/db/tenant-scope";
import { ApiKeysService, LAST_USED_UPDATE_INTERVAL_MS } from "./api-keys.service";
import { generateApiKey, hashApiKey } from "./key-generation";

const INGEST = /^pa_ing_[A-Za-z0-9_-]{43}$/;

let testDb: TestDatabase;
let app: INestApplication;
let service: ApiKeysService;
const clock = new FakeClock("2026-10-14T12:00:00.000Z");
let a: FixtureUser;
let b: FixtureUser;

beforeAll(async () => {
  testDb = await startTestDatabase();
  app = await buildFixtureApp(testDb, { clock });
  service = app.get(ApiKeysService);
  ({ a, b } = await seedTwoUsers(app, testDb));
}, 240_000);

afterAll(async () => {
  await app?.close();
  await testDb?.stop();
});

const keyRow = async (keyId: string) => {
  const [row] = await testDb.db.select().from(apiKeys).where(eq(apiKeys.id, keyId));
  return row;
};

/** A new `http` integration owned by `userId`, inserted through the scoped helper. */
async function newIntegration(userId: string) {
  const [row] = await tenantScope(testDb.db, userId).insert(integrations, {
    kind: "http",
    name: `extra-${Math.random().toString(36).slice(2)}`,
  });
  if (!row) throw new Error("integration not created");
  return row;
}

describe("createIngestKey", () => {
  it("returns a pa_ing_ key once, with its row id and display prefix", async () => {
    const created = await service.createIngestKey(a.userId, a.integrationId);
    expect(created.key).toMatch(INGEST);
    expect(created.key.startsWith(created.prefix)).toBe(true);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("stores kind, owner, integration, prefix and the SHA-256 hash, nothing else secret", async () => {
    const created = await service.createIngestKey(a.userId, a.integrationId);
    const row = await keyRow(created.id);
    expect(row).toMatchObject({
      userId: a.userId,
      kind: "ingest",
      integrationId: a.integrationId,
      prefix: created.prefix,
      hash: hashApiKey(created.key),
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(row?.scopes).toEqual([]);
  });

  it("never stores the plaintext (or its secret part) in any column", async () => {
    const created = await service.createIngestKey(b.userId, b.integrationId);
    const secret = created.key.slice("pa_ing_".length);
    const row = await keyRow(created.id);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(created.key);
    expect(serialized).not.toContain(secret);
    // The whole table, via raw SQL, in case a column is not in the Drizzle schema.
    const raw = await testDb.pool.query("select * from api_keys");
    expect(JSON.stringify(raw.rows)).not.toContain(secret);
  });

  it("makes every key different", async () => {
    const first = await service.createIngestKey(a.userId, a.integrationId);
    const second = await service.createIngestKey(a.userId, a.integrationId);
    expect(first.key).not.toBe(second.key);
    expect(first.id).not.toBe(second.id);
  });

  it("refuses to mint a key for another user's integration, and stores nothing", async () => {
    const before = await testDb.db.select().from(apiKeys);
    await expect(service.createIngestKey(a.userId, b.integrationId)).rejects.toThrow();
    const after = await testDb.db.select().from(apiKeys);
    expect(after).toHaveLength(before.length);
  });

  it("refuses an integration id that does not exist", async () => {
    await expect(
      service.createIngestKey(a.userId, "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b"),
    ).rejects.toThrow();
    await expect(service.createIngestKey(a.userId, "not-a-uuid")).rejects.toThrow();
  });

  it("rejects with MissingUserScopeError when userId is missing", async () => {
    for (const bad of ["", "  ", undefined, null]) {
      await expect(service.createIngestKey(bad as never, a.integrationId)).rejects.toBeInstanceOf(
        MissingUserScopeError,
      );
    }
  });
});

describe("authenticateIngestKey", () => {
  it("resolves a valid key to its owner, integration and key id", async () => {
    expect(await service.authenticateIngestKey(a.ingestKey)).toEqual({
      kind: "ingest",
      userId: a.userId,
      integrationId: a.integrationId,
      keyId: a.ingestKeyId,
    });
  });

  it("gives each user their own context (A's key never resolves to B, and vice versa)", async () => {
    const ctxA = await service.authenticateIngestKey(a.ingestKey);
    const ctxB = await service.authenticateIngestKey(b.ingestKey);
    expect(ctxA?.userId).toBe(a.userId);
    expect(ctxB?.userId).toBe(b.userId);
    expect(ctxB?.integrationId).toBe(b.integrationId);
    expect(ctxB?.integrationId).not.toBe(a.integrationId);
  });

  it("returns null (never throws) for missing, malformed and unknown keys", async () => {
    const unknownButWellFormed = generateApiKey("ingest").plaintext;
    const real = a.ingestKey;
    const flipped = `${real.slice(0, -1)}${real.endsWith("A") ? "B" : "A"}`;
    const inputs: unknown[] = [
      undefined,
      null,
      "",
      " ",
      "pa_ing_",
      "pa_ing_short",
      "garbage",
      unknownButWellFormed,
      flipped,
      real.slice(0, -1),
      `${real}x`,
      real.toUpperCase(),
      real.toLowerCase() === real ? real.toUpperCase() : real.toLowerCase(),
      ` ${real}`,
      `${real} `,
      `${real}\u0000`,
      "pa_ing_\u0000\u0000",
      "ключ-🔑",
      "x".repeat(100_000),
      123,
      {},
      ["pa_ing_x"],
    ];
    for (const input of inputs) {
      await expect(
        service.authenticateIngestKey(input as never),
        `input: ${String(input).slice(0, 40)}`,
      ).resolves.toBeNull();
    }
  });

  it("returns null for a pa_read_ key, even a valid stored one", async () => {
    const read = generateApiKey("read");
    await testDb.db.insert(apiKeys).values({
      userId: a.userId,
      kind: "read",
      prefix: read.prefix,
      hash: read.hash,
    });
    expect(await service.authenticateIngestKey(read.plaintext)).toBeNull();
  });

  it("returns null for a stored ingest-kind row presented without the pa_ing_ marker", async () => {
    const created = await service.createIngestKey(a.userId, a.integrationId);
    const secret = created.key.slice("pa_ing_".length);
    expect(await service.authenticateIngestKey(`pa_read_${secret}`)).toBeNull();
    expect(await service.authenticateIngestKey(secret)).toBeNull();
  });

  it("looks the key up by its hash: moving the hash moves the key", async () => {
    const created = await service.createIngestKey(a.userId, a.integrationId);
    const replacement = generateApiKey("ingest");
    await testDb.db
      .update(apiKeys)
      .set({ hash: replacement.hash })
      .where(eq(apiKeys.id, created.id));
    expect(await service.authenticateIngestKey(created.key)).toBeNull();
    expect(await service.authenticateIngestKey(replacement.plaintext)).toMatchObject({
      keyId: created.id,
    });
  });

  it("returns null for a revoked key", async () => {
    const created = await service.createIngestKey(a.userId, a.integrationId);
    expect(await service.authenticateIngestKey(created.key)).not.toBeNull();
    await testDb.db
      .update(apiKeys)
      .set({ revokedAt: clock.now() })
      .where(eq(apiKeys.id, created.id));
    expect(await service.authenticateIngestKey(created.key)).toBeNull();
  });

  it("returns null for a live key whose integration is revoked", async () => {
    const integration = await newIntegration(a.userId);
    const created = await service.createIngestKey(a.userId, integration.id);
    expect(await service.authenticateIngestKey(created.key)).not.toBeNull();
    await testDb.db
      .update(integrations)
      .set({ status: "revoked" })
      .where(eq(integrations.id, integration.id));
    expect(await service.authenticateIngestKey(created.key)).toBeNull();
  });

  it("returns null once the integration row is deleted (keys cascade with it)", async () => {
    const integration = await newIntegration(b.userId);
    const created = await service.createIngestKey(b.userId, integration.id);
    await testDb.db.delete(integrations).where(eq(integrations.id, integration.id));
    expect(await service.authenticateIngestKey(created.key)).toBeNull();
  });
});

describe("revokeKey", () => {
  it("revokes the user's own key at the clock time, and the key stops working immediately", async () => {
    const created = await service.createIngestKey(a.userId, a.integrationId);
    clock.set("2026-10-14T13:00:00.000Z");
    expect(await service.revokeKey(a.userId, created.id)).toBe(true);
    expect((await keyRow(created.id))?.revokedAt).toEqual(new Date("2026-10-14T13:00:00.000Z"));
    expect(await service.authenticateIngestKey(created.key)).toBeNull();
  });

  it("returns false and changes nothing when another user tries to revoke the key", async () => {
    const created = await service.createIngestKey(a.userId, a.integrationId);
    expect(await service.revokeKey(b.userId, created.id)).toBe(false);
    expect((await keyRow(created.id))?.revokedAt).toBeNull();
    expect(await service.authenticateIngestKey(created.key)).not.toBeNull();
  });

  it("returns false for an unknown key id", async () => {
    expect(await service.revokeKey(a.userId, "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b")).toBe(false);
  });

  it("keeps the original revoked_at when revoked twice", async () => {
    const created = await service.createIngestKey(a.userId, a.integrationId);
    clock.set("2026-10-14T14:00:00.000Z");
    await service.revokeKey(a.userId, created.id);
    clock.set("2026-10-14T15:00:00.000Z");
    await service.revokeKey(a.userId, created.id);
    expect((await keyRow(created.id))?.revokedAt).toEqual(new Date("2026-10-14T14:00:00.000Z"));
  });

  it("rejects with MissingUserScopeError when userId is missing", async () => {
    for (const bad of ["", undefined, null]) {
      await expect(service.revokeKey(bad as never, a.ingestKeyId)).rejects.toBeInstanceOf(
        MissingUserScopeError,
      );
    }
    expect((await keyRow(a.ingestKeyId))?.revokedAt).toBeNull();
  });
});

describe("last_used_at throttle (fixed clock)", () => {
  it("uses an interval between one second and one day", () => {
    expect(LAST_USED_UPDATE_INTERVAL_MS).toBeGreaterThanOrEqual(1_000);
    expect(LAST_USED_UPDATE_INTERVAL_MS).toBeLessThanOrEqual(24 * 60 * 60 * 1_000);
  });

  it("is null before first use and set to the clock time on first successful use", async () => {
    const created = await service.createIngestKey(a.userId, a.integrationId);
    expect((await keyRow(created.id))?.lastUsedAt).toBeNull();
    clock.set("2026-10-15T09:00:00.000Z");
    await service.authenticateIngestKey(created.key);
    expect((await keyRow(created.id))?.lastUsedAt).toEqual(new Date("2026-10-15T09:00:00.000Z"));
  });

  it("does not write again anywhere inside the interval", async () => {
    const created = await service.createIngestKey(a.userId, a.integrationId);
    const t0 = new Date("2026-10-15T10:00:00.000Z");
    clock.set(t0);
    await service.authenticateIngestKey(created.key);
    for (const offset of [
      1,
      1_000,
      LAST_USED_UPDATE_INTERVAL_MS / 2,
      LAST_USED_UPDATE_INTERVAL_MS - 1,
    ]) {
      clock.set(new Date(t0.getTime() + offset));
      expect(await service.authenticateIngestKey(created.key)).not.toBeNull();
      expect((await keyRow(created.id))?.lastUsedAt, `offset ${offset}`).toEqual(t0);
    }
  });

  it("writes again once the interval has passed, then throttles from the new time", async () => {
    const created = await service.createIngestKey(a.userId, a.integrationId);
    const t0 = new Date("2026-10-15T11:00:00.000Z");
    clock.set(t0);
    await service.authenticateIngestKey(created.key);

    const t1 = new Date(t0.getTime() + LAST_USED_UPDATE_INTERVAL_MS + 1);
    clock.set(t1);
    await service.authenticateIngestKey(created.key);
    expect((await keyRow(created.id))?.lastUsedAt).toEqual(t1);

    clock.set(new Date(t1.getTime() + LAST_USED_UPDATE_INTERVAL_MS - 1));
    await service.authenticateIngestKey(created.key);
    expect((await keyRow(created.id))?.lastUsedAt).toEqual(t1);
  });

  it("throttles each key on its own", async () => {
    const first = await service.createIngestKey(a.userId, a.integrationId);
    const second = await service.createIngestKey(b.userId, b.integrationId);
    const t0 = new Date("2026-10-15T12:00:00.000Z");
    clock.set(t0);
    await service.authenticateIngestKey(first.key);
    const t1 = new Date(t0.getTime() + 5_000);
    clock.set(t1);
    await service.authenticateIngestKey(second.key);
    expect((await keyRow(first.id))?.lastUsedAt).toEqual(t0);
    expect((await keyRow(second.id))?.lastUsedAt).toEqual(t1);
  });

  it("many concurrent first uses leave one consistent last_used_at", async () => {
    const created = await service.createIngestKey(a.userId, a.integrationId);
    const t0 = new Date("2026-10-15T13:00:00.000Z");
    clock.set(t0);
    const results = await Promise.all(
      Array.from({ length: 25 }, () => service.authenticateIngestKey(created.key)),
    );
    expect(results.every((ctx) => ctx?.keyId === created.id)).toBe(true);
    expect((await keyRow(created.id))?.lastUsedAt).toEqual(t0);
  });

  it("does not touch last_used_at on a failed attempt (revoked key)", async () => {
    const created = await service.createIngestKey(a.userId, a.integrationId);
    const t0 = new Date("2026-10-15T14:00:00.000Z");
    clock.set(t0);
    await service.authenticateIngestKey(created.key);
    clock.set(new Date(t0.getTime() + 3 * LAST_USED_UPDATE_INTERVAL_MS));
    await service.revokeKey(a.userId, created.id);
    clock.set(new Date(t0.getTime() + 5 * LAST_USED_UPDATE_INTERVAL_MS));
    expect(await service.authenticateIngestKey(created.key)).toBeNull();
    expect((await keyRow(created.id))?.lastUsedAt).toEqual(t0);
  });

  it("does not touch last_used_at when the integration is revoked", async () => {
    const integration = await newIntegration(a.userId);
    const created = await service.createIngestKey(a.userId, integration.id);
    const t0 = new Date("2026-10-15T15:00:00.000Z");
    clock.set(t0);
    await service.authenticateIngestKey(created.key);
    await testDb.db
      .update(integrations)
      .set({ status: "revoked" })
      .where(eq(integrations.id, integration.id));
    clock.set(new Date(t0.getTime() + 5 * LAST_USED_UPDATE_INTERVAL_MS));
    expect(await service.authenticateIngestKey(created.key)).toBeNull();
    expect((await keyRow(created.id))?.lastUsedAt).toEqual(t0);
  });
});
