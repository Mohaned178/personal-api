/**
 * M1-03 IngestKeyGuard over HTTP against the real application (Testcontainers; CI runs these,
 * Docker may be off locally), using the two-user fixture and the test-only /probe routes.
 *
 * Contract: unknown, malformed, revoked, revoked-integration and pa_read_ keys all get the SAME
 * 401 application/problem+json with code `auth.invalid_key` (no oracle). A session cookie cannot
 * pass IngestKeyGuard and an ingest key cannot pass SessionGuard. Revocation is effective on the
 * very next request.
 */
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureOutput } from "../../../test/auth.helpers";
import { FakeClock } from "../../../test/fake-clock";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { buildFixtureApp, type FixtureUser, seedTwoUsers } from "../../../test/two-user-fixture";
import { apiKeys, integrations } from "../../platform/db/schema";
import { tenantScope } from "../../platform/db/tenant-scope";
import { ApiKeysService, LAST_USED_UPDATE_INTERVAL_MS } from "./api-keys.service";
import { generateApiKey, hashApiKey } from "./key-generation";

const PROBLEM_JSON = /^application\/problem\+json/;

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

const http = () => request(app.getHttpServer());
const probe = (key?: string) => {
  const req = http().get("/probe/ingest");
  return key ? req.set("Authorization", `Bearer ${key}`) : req;
};

async function freshIngestKey(user: FixtureUser) {
  return service.createIngestKey(user.userId, user.integrationId);
}

describe("a valid ingest key", () => {
  it("authenticates and carries the key's own user, integration and key id", async () => {
    const res = await probe(a.ingestKey);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      kind: "ingest",
      userId: a.userId,
      integrationId: a.integrationId,
      keyId: a.ingestKeyId,
    });
  });

  it("never resolves user B's key to user A's integration, or the reverse", async () => {
    const asB = await probe(b.ingestKey);
    expect(asB.body).toMatchObject({ userId: b.userId, integrationId: b.integrationId });
    expect(asB.body.userId).not.toBe(a.userId);
    expect(asB.body.integrationId).not.toBe(a.integrationId);
    const asA = await probe(a.ingestKey);
    expect(asA.body).toMatchObject({ userId: a.userId, integrationId: a.integrationId });
  });

  it("ignores a userId or integrationId smuggled in the query, body or headers", async () => {
    const res = await http()
      .post(`/probe/ingest?userId=${b.userId}&integrationId=${b.integrationId}`)
      .set("Authorization", `Bearer ${a.ingestKey}`)
      .set("X-User-Id", b.userId)
      .send({ userId: b.userId, integrationId: b.integrationId, keyId: b.ingestKeyId });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      userId: a.userId,
      integrationId: a.integrationId,
      keyId: a.ingestKeyId,
    });
  });

  it("is decided by the key alone, even with another user's valid session cookie attached", async () => {
    const res = await probe(a.ingestKey).set("Cookie", b.cookie);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(a.userId);
  });

  it("sets last_used_at from the clock on use", async () => {
    const created = await freshIngestKey(a);
    const t0 = new Date("2026-11-01T08:00:00.000Z");
    clock.set(t0);
    await probe(created.key);
    clock.set(new Date(t0.getTime() + LAST_USED_UPDATE_INTERVAL_MS - 1));
    await probe(created.key);
    const [row] = await testDb.db.select().from(apiKeys).where(eq(apiKeys.id, created.id));
    expect(row?.lastUsedAt).toEqual(t0);
  });
});

describe("rejected keys all get the same 401 (no oracle)", () => {
  /** Builds one key per rejection reason, so each can be compared to the others. */
  async function rejectionCases(): Promise<Array<[string, () => ReturnType<typeof probe>]>> {
    const revoked = await freshIngestKey(a);
    await service.revokeKey(a.userId, revoked.id);

    const [integration] = await tenantScope(testDb.db, a.userId).insert(integrations, {
      kind: "http",
      name: "to-be-revoked",
    });
    if (!integration) throw new Error("integration not created");
    const orphaned = await service.createIngestKey(a.userId, integration.id);
    await testDb.db
      .update(integrations)
      .set({ status: "revoked" })
      .where(eq(integrations.id, integration.id));

    const read = generateApiKey("read");
    await testDb.db
      .insert(apiKeys)
      .values({ userId: a.userId, kind: "read", prefix: read.prefix, hash: read.hash });

    return [
      ["no Authorization header", () => probe()],
      ["unknown well-formed key", () => probe(generateApiKey("ingest").plaintext)],
      ["malformed key", () => probe("pa_ing_not-a-real-key")],
      ["truncated key", () => probe(a.ingestKey.slice(0, 20))],
      [
        "altered last character",
        () => probe(`${a.ingestKey.slice(0, -1)}${a.ingestKey.endsWith("A") ? "B" : "A"}`),
      ],
      ["not a pa_ key at all", () => probe("hello")],
      ["revoked key", () => probe(revoked.key)],
      ["live key of a revoked integration", () => probe(orphaned.key)],
      ["valid pa_read_ key", () => probe(read.plaintext)],
      [
        "wrong scheme",
        () => http().get("/probe/ingest").set("Authorization", `Basic ${a.ingestKey}`),
      ],
      ["token without scheme", () => http().get("/probe/ingest").set("Authorization", a.ingestKey)],
      [
        "key in the query string only",
        () => http().get("/probe/ingest").query({ key: a.ingestKey }),
      ],
      [
        "key in a cookie only",
        () => http().get("/probe/ingest").set("Cookie", `pa_ing=${a.ingestKey}`),
      ],
      ["key in X-Api-Key only", () => http().get("/probe/ingest").set("X-Api-Key", a.ingestKey)],
    ];
  }

  it("answers 401 application/problem+json with code auth.invalid_key for every reason", async () => {
    for (const [reason, send] of await rejectionCases()) {
      const res = await send();
      expect(res.status, reason).toBe(401);
      expect(res.headers["content-type"], reason).toMatch(PROBLEM_JSON);
      expect(res.body, reason).toMatchObject({ status: 401, code: "auth.invalid_key" });
    }
  });

  it("gives byte-identical bodies for every reason, so the response says nothing about why", async () => {
    const cases = await rejectionCases();
    const baseline = await cases[0]?.[1]();
    for (const [reason, send] of cases) {
      const res = await send();
      expect(res.text, reason).toBe(baseline?.text);
    }
  });

  it("does not echo the presented key in the response", async () => {
    const key = generateApiKey("ingest").plaintext;
    const res = await probe(key);
    expect(res.text).not.toContain(key);
    expect(res.text).not.toContain(key.slice("pa_ing_".length));
    expect(JSON.stringify(res.headers)).not.toContain(key);
  });
});

describe("revocation takes effect on the very next request", () => {
  it("a revoked key goes from 200 to 401 with no delay", async () => {
    const created = await freshIngestKey(a);
    expect((await probe(created.key)).status).toBe(200);
    expect(await service.revokeKey(a.userId, created.id)).toBe(true);
    const res = await probe(created.key);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("auth.invalid_key");
  });

  it("revoking the integration blocks its keys on the very next request", async () => {
    const [integration] = await tenantScope(testDb.db, b.userId).insert(integrations, {
      kind: "http",
      name: "revoked-next",
    });
    if (!integration) throw new Error("integration not created");
    const created = await service.createIngestKey(b.userId, integration.id);
    expect((await probe(created.key)).status).toBe(200);
    await testDb.db
      .update(integrations)
      .set({ status: "revoked" })
      .where(eq(integrations.id, integration.id));
    expect((await probe(created.key)).status).toBe(401);
  });

  it("revoking one key leaves the user's other keys working", async () => {
    const first = await freshIngestKey(a);
    const second = await freshIngestKey(a);
    await service.revokeKey(a.userId, first.id);
    expect((await probe(first.key)).status).toBe(401);
    expect((await probe(second.key)).status).toBe(200);
  });

  it("another user cannot revoke the key (revokeKey is false) and it keeps working", async () => {
    const created = await freshIngestKey(a);
    expect(await service.revokeKey(b.userId, created.id)).toBe(false);
    expect((await probe(created.key)).status).toBe(200);
  });
});

describe("session and ingest credentials are not interchangeable", () => {
  it("a valid dashboard session cookie cannot pass IngestKeyGuard", async () => {
    const res = await http().get("/probe/ingest").set("Cookie", a.cookie);
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("auth.invalid_key");
  });

  it("the session token sent as a bearer token cannot pass IngestKeyGuard either", async () => {
    const value = decodeURIComponent(a.cookie.slice(a.cookie.indexOf("=") + 1));
    for (const token of [value, value.split(".")[0] ?? value]) {
      const res = await probe(token);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("auth.invalid_key");
    }
  });

  it("a valid ingest key cannot pass SessionGuard on /v1/me", async () => {
    const res = await http().get("/v1/me").set("Authorization", `Bearer ${a.ingestKey}`);
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("auth.unauthenticated");
  });

  it("a valid ingest key cannot pass SessionGuard on the probe session route", async () => {
    const res = await http().get("/probe/session").set("Authorization", `Bearer ${a.ingestKey}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("auth.unauthenticated");
  });

  it("a stored pa_read_ key cannot pass SessionGuard", async () => {
    const read = generateApiKey("read");
    await testDb.db
      .insert(apiKeys)
      .values({ userId: a.userId, kind: "read", prefix: read.prefix, hash: read.hash });
    const res = await http().get("/v1/me").set("Authorization", `Bearer ${read.plaintext}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("auth.unauthenticated");
  });

  it("real sessions still work and carry kind 'session'", async () => {
    const res = await http().get("/probe/session").set("Cookie", a.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: "session", userId: a.userId });
  });

  it("CurrentAuth fails closed (500) when a route asks for the other kind", async () => {
    const asSession = await http()
      .get("/probe/ingest-as-session")
      .set("Authorization", `Bearer ${a.ingestKey}`);
    expect(asSession.status).toBe(500);
    const asIngest = await http().get("/probe/session-as-ingest").set("Cookie", a.cookie);
    expect(asIngest.status).toBe(500);
    const unguarded = await http()
      .get("/probe/unguarded-ingest")
      .set("Authorization", `Bearer ${a.ingestKey}`);
    expect(unguarded.status).toBe(500);
  });
});

describe("logs never contain keys or hashes (invariant 6)", () => {
  it("keeps a valid key, a rejected key and their hashes out of log output", async () => {
    const created = await freshIngestKey(a);
    const rejected = generateApiKey("ingest");
    const capture = captureOutput();
    let output = "";
    try {
      await probe(created.key);
      await probe(rejected.plaintext);
      await probe("pa_ing_malformed");
    } finally {
      output = capture.stop();
    }
    // Prove we really captured the app's request logs; otherwise the assertions below are vacuous.
    expect(output, "captured log output should include the request log lines").toContain(
      "statusCode",
    );
    for (const secret of [created.key, rejected.plaintext]) {
      expect(output).not.toContain(secret);
      expect(output).not.toContain(secret.slice("pa_ing_".length));
      expect(output).not.toContain(hashApiKey(secret));
    }
  });
});
