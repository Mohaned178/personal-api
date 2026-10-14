/**
 * M1-03 the two-user fixture itself (apps/api/test/two-user-fixture.ts). Every later milestone's
 * cross-tenant tests reuse it, so its guarantees are tested here (Testcontainers; CI runs these).
 *
 * The fixture file is a stub the builder implements; the contract is documented in that file.
 */
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { meUser } from "../../../test/auth.helpers";
import { FakeClock } from "../../../test/fake-clock";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { buildFixtureApp, type FixtureUser, seedTwoUsers } from "../../../test/two-user-fixture";
import { CLOCK } from "../../platform/clock/clock";
import { apiKeys, integrations, user } from "../../platform/db/schema";
import { hashApiKey } from "./key-generation";

let testDb: TestDatabase;
let app: INestApplication;
const clock = new FakeClock("2026-10-14T12:00:00.000Z");
let a: FixtureUser;
let b: FixtureUser;

beforeAll(async () => {
  testDb = await startTestDatabase();
  app = await buildFixtureApp(testDb, { clock });
  ({ a, b } = await seedTwoUsers(app, testDb));
}, 240_000);

afterAll(async () => {
  await app?.close();
  await testDb?.stop();
});

const http = () => request(app.getHttpServer());

describe("two-user fixture", () => {
  it("creates two distinct users with distinct integrations and keys", () => {
    expect(a.userId).not.toBe(b.userId);
    expect(a.integrationId).not.toBe(b.integrationId);
    expect(a.ingestKeyId).not.toBe(b.ingestKeyId);
    expect(a.ingestKey).not.toBe(b.ingestKey);
    expect(a.credentials.email).not.toBe(b.credentials.email);
  });

  it("gives each user a working dashboard session cookie for their own account", async () => {
    const meA = await http().get("/v1/me").set("Cookie", a.cookie);
    const meB = await http().get("/v1/me").set("Cookie", b.cookie);
    expect(meA.status).toBe(200);
    expect(meB.status).toBe(200);
    expect(meUser(meA.body).id).toBe(a.userId);
    expect(meUser(meB.body).id).toBe(b.userId);
    expect(meUser(meA.body).email).toBe(a.credentials.email);
  });

  it("gives each user an http integration that is active, deny-by-default and theirs alone", async () => {
    for (const fixtureUser of [a, b]) {
      const [row] = await testDb.db
        .select()
        .from(integrations)
        .where(eq(integrations.id, fixtureUser.integrationId));
      expect(row).toMatchObject({
        userId: fixtureUser.userId,
        kind: "http",
        defaultPolicy: "deny",
        status: "active",
      });
    }
    const all = await testDb.db.select().from(integrations);
    expect(all).toHaveLength(2);
  });

  it("gives each user exactly one live ingest key, stored only as a hash", async () => {
    const rows = await testDb.db.select().from(apiKeys);
    expect(rows).toHaveLength(2);
    for (const fixtureUser of [a, b]) {
      const row = rows.find((candidate) => candidate.id === fixtureUser.ingestKeyId);
      expect(row).toMatchObject({
        userId: fixtureUser.userId,
        kind: "ingest",
        integrationId: fixtureUser.integrationId,
        hash: hashApiKey(fixtureUser.ingestKey),
        revokedAt: null,
      });
      expect(JSON.stringify(row)).not.toContain(fixtureUser.ingestKey);
    }
  });

  it("makes each ingest key authenticate as its own user through the probe route", async () => {
    const resA = await http().get("/probe/ingest").set("Authorization", `Bearer ${a.ingestKey}`);
    const resB = await http().get("/probe/ingest").set("Authorization", `Bearer ${b.ingestKey}`);
    expect(resA.body).toEqual({
      kind: "ingest",
      userId: a.userId,
      integrationId: a.integrationId,
      keyId: a.ingestKeyId,
    });
    expect(resB.body).toEqual({
      kind: "ingest",
      userId: b.userId,
      integrationId: b.integrationId,
      keyId: b.ingestKeyId,
    });
  });

  it("uses the injected clock for the CLOCK provider", () => {
    expect(app.get(CLOCK)).toBe(clock);
  });

  it("starts from a clean slate each time it seeds (no leftovers from an earlier seeding)", async () => {
    const before = await testDb.db.select().from(user);
    expect(before).toHaveLength(2);
    const again = await seedTwoUsers(app, testDb);
    const after = await testDb.db.select().from(user);
    expect(after).toHaveLength(2);
    expect(after.map((row) => row.id).sort()).toEqual([again.a.userId, again.b.userId].sort());
    expect(await testDb.db.select().from(integrations)).toHaveLength(2);
    expect(await testDb.db.select().from(apiKeys)).toHaveLength(2);
    // Keep later tests in this file independent of the reseed.
    a = again.a;
    b = again.b;
  });

  it("deleting a user cascades to their integration and key, and only theirs", async () => {
    await testDb.db.delete(user).where(eq(user.id, a.userId));
    expect(await testDb.db.select().from(integrations)).toHaveLength(1);
    expect(await testDb.db.select().from(apiKeys)).toHaveLength(1);
    const res = await http().get("/probe/ingest").set("Authorization", `Bearer ${a.ingestKey}`);
    expect(res.status).toBe(401);
    const stillB = await http().get("/probe/ingest").set("Authorization", `Bearer ${b.ingestKey}`);
    expect(stillB.status).toBe(200);
  });
});
