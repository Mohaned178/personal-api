/**
 * M5-01 read keys over HTTP against the real application (Testcontainers; CI runs these, Docker
 * may be off locally): the session routes under /v1/keys, and ReadKeyGuard on the test-only /probe
 * routes. Uses the two-user fixture.
 *
 * Contract: the plaintext key appears only in the create response; every authentication failure is
 * the same 401 `auth.invalid_key`; a valid key without the route's scope is 403
 * `auth.insufficient_scope`; a route behind the guard that declares no scope fails closed (500);
 * a key whose stored scopes or restriction do not parse is refused.
 */
import type { INestApplication } from "@nestjs/common";
import {
  createReadKeyResponseSchema,
  endpointScope,
  readKeyListResponseSchema,
  readKeyResponseSchema,
} from "@personal-api/contracts";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureOutput } from "../../../test/auth.helpers";
import { FakeClock } from "../../../test/fake-clock";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { buildFixtureApp, type FixtureUser, seedTwoUsers } from "../../../test/two-user-fixture";
import { apiKeys } from "../../platform/db/schema";
import { LAST_USED_UPDATE_INTERVAL_MS } from "./api-keys.service";
import { generateApiKey, hashApiKey } from "./key-generation";

const PROBLEM_JSON = /^application\/problem\+json/;
const MISSING = "0192f1c2-7c1e-7a3b-9f00-000000000000";

let testDb: TestDatabase;
let app: INestApplication;
const clock = new FakeClock("2026-10-19T12:00:00.000Z");
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
const create = (user: FixtureUser, body: unknown) =>
  http()
    .post("/v1/keys")
    .set("Cookie", user.cookie)
    .send(body as object);
const list = (user: FixtureUser) => http().get("/v1/keys").set("Cookie", user.cookie);
const revoke = (user: FixtureUser, id: string) =>
  http().post(`/v1/keys/${id}/revoke`).set("Cookie", user.cookie);
const probe = (path: string, key?: string) => {
  const req = http().get(`/probe/${path}`);
  return key ? req.set("Authorization", `Bearer ${key}`) : req;
};

async function mint(user: FixtureUser, body: object = { scopes: ["events:read"] }) {
  const res = await create(user, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return createReadKeyResponseSchema.parse(res.body);
}

async function storedRow(id: string) {
  const [row] = await testDb.db.select().from(apiKeys).where(eq(apiKeys.id, id));
  if (!row) throw new Error("key row not found");
  return row;
}

describe("POST /v1/keys", () => {
  it("returns the key once, uncached, and stores only its hash", async () => {
    const res = await create(a, { name: "  Widget  ", scopes: ["events:read", "activity:read"] });
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const created = createReadKeyResponseSchema.parse(res.body);
    expect(created.key).toMatch(/^pa_read_[A-Za-z0-9_-]{43}$/);
    expect(created.readKey).toMatchObject({
      name: "Widget",
      prefix: created.key.slice(0, "pa_read_".length + 6),
      scopes: ["events:read", "activity:read"],
      restriction: null,
      lastUsedAt: null,
      revokedAt: null,
    });

    const row = await storedRow(created.readKey.id);
    expect(row).toMatchObject({
      userId: a.userId,
      kind: "read",
      integrationId: null,
      hash: hashApiKey(created.key),
    });
    expect(JSON.stringify(row)).not.toContain(created.key);
    expect(JSON.stringify(row)).not.toContain(created.key.slice("pa_read_".length));
  });

  it("works without a name and stores a restriction, dropping repeats", async () => {
    const created = await mint(a, {
      scopes: ["events:read"],
      restriction: {
        sources: [a.integrationId, a.integrationId],
        types: ["browser.*", "browser.*", "browser.page_visited"],
      },
    });
    expect(created.readKey.name).toBeNull();
    expect(created.readKey.restriction).toEqual({
      sources: [a.integrationId],
      types: ["browser.*", "browser.page_visited"],
    });
    expect((await storedRow(created.readKey.id)).restriction).toEqual(created.readKey.restriction);
  });

  it("never shows the key or the hash again in the list or in a revoke answer", async () => {
    const created = await mint(a);
    const listed = await list(a);
    const revoked = await revoke(a, created.readKey.id);
    for (const res of [listed, revoked]) {
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(created.key);
      expect(text).not.toContain(created.key.slice("pa_read_".length));
      expect(text).not.toContain(hashApiKey(created.key));
      expect(text).not.toContain('"hash"');
    }
  });

  it.each([
    ["no scopes", {}],
    ["an empty scope list", { scopes: [] }],
    ["an unknown scope", { scopes: ["events:write"] }],
    ["an endpoint scope (minted with the endpoint, M5-05)", { scopes: [`endpoint:${MISSING}`] }],
    ["a userId", { scopes: ["events:read"], userId: "someone" }],
    ["an integrationId", { scopes: ["events:read"], integrationId: MISSING }],
    ["a kind", { scopes: ["events:read"], kind: "ingest" }],
    ["a type with a LIKE wildcard", { scopes: ["events:read"], restriction: { types: ["a%"] } }],
    ["an empty restriction", { scopes: ["events:read"], restriction: {} }],
    ["a blank name", { scopes: ["events:read"], name: "  " }],
  ])("rejects %s with 400 request.invalid and stores nothing", async (_label, body) => {
    const before = (await list(a)).body.readKeys.length;
    const res = await create(a, body);
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("request.invalid");
    expect((await list(a)).body.readKeys).toHaveLength(before);
  });

  it("does not echo a rejected value", async () => {
    const res = await create(a, {
      scopes: ["events:read"],
      restriction: { types: ["SECRET-pattern-5d2f"] },
    });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain("SECRET-pattern-5d2f");
  });

  it("a restriction naming someone else's integration is the same 404 as an unknown one, and stores nothing", async () => {
    const before = await testDb.pool.query("select count(*)::int as n from api_keys");
    const foreign = await create(a, {
      scopes: ["events:read"],
      restriction: { sources: [b.integrationId] },
    });
    const unknown = await create(a, {
      scopes: ["events:read"],
      restriction: { sources: [MISSING] },
    });
    const mixed = await create(a, {
      scopes: ["events:read"],
      restriction: { sources: [a.integrationId, b.integrationId] },
    });
    for (const res of [foreign, unknown, mixed]) {
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe("integration.not_found");
    }
    expect(foreign.body).toEqual(unknown.body);
    expect(JSON.stringify(foreign.body)).not.toContain(b.integrationId);
    const after = await testDb.pool.query("select count(*)::int as n from api_keys");
    expect(after.rows).toEqual(before.rows);
  });

  it("ignores a userId or integrationId smuggled in the query or headers", async () => {
    const res = await http()
      .post(`/v1/keys?userId=${b.userId}&integrationId=${b.integrationId}`)
      .set("Cookie", a.cookie)
      .set("X-User-Id", b.userId)
      .send({ scopes: ["events:read"] });
    expect(res.status).toBe(201);
    const row = await storedRow(createReadKeyResponseSchema.parse(res.body).readKey.id);
    expect(row.userId).toBe(a.userId);
    expect(row.integrationId).toBeNull();
  });

  it("is 401 without a session, with an ingest key, or with a read key as bearer", async () => {
    const read = await mint(a);
    for (const bearer of [undefined, a.ingestKey, read.key]) {
      let req = http().post("/v1/keys");
      if (bearer) req = req.set("Authorization", `Bearer ${bearer}`);
      const res = await req.send({ scopes: ["events:read"] });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("auth.unauthenticated");
    }
  });
});

describe("GET /v1/keys and revoking", () => {
  it("lists only the caller's read keys, newest first, revoked ones included", async () => {
    const first = await mint(b, { name: "first", scopes: ["events:read"] });
    clock.advance(1000);
    const second = await mint(b, { name: "second", scopes: ["activity:read"] });
    await revoke(b, first.readKey.id);

    const res = await list(b);
    expect(res.status).toBe(200);
    const keys = readKeyListResponseSchema.parse(res.body).readKeys;
    const ids = keys.map((k) => k.id);
    expect(ids.indexOf(second.readKey.id)).toBeLessThan(ids.indexOf(first.readKey.id));
    expect(keys.find((k) => k.id === first.readKey.id)?.revokedAt).not.toBeNull();
    // Not user A's keys, and never an ingest key.
    const aIds = (await list(a)).body.readKeys.map((k: { id: string }) => k.id);
    expect(ids.some((id) => aIds.includes(id))).toBe(false);
    expect(ids).not.toContain(b.ingestKeyId);
    expect(JSON.stringify(res.body)).not.toContain(b.ingestKey);
  });

  it("revokes, and a second revoke keeps the first revocation time", async () => {
    const created = await mint(a);
    const t0 = new Date("2026-12-01T09:00:00.000Z");
    clock.set(t0);
    const first = await revoke(a, created.readKey.id);
    expect(first.status).toBe(200);
    expect(readKeyResponseSchema.parse(first.body).readKey.revokedAt).toBe(t0.toISOString());
    clock.set(new Date(t0.getTime() + 60_000));
    const second = await revoke(a, created.readKey.id);
    expect(second.status).toBe(200);
    expect(second.body.readKey.revokedAt).toBe(t0.toISOString());
  });

  it("answers the same 404 for another user's key, an unknown id and a malformed id", async () => {
    const mine = await mint(a);
    const foreign = await revoke(b, mine.readKey.id);
    const unknown = await revoke(b, MISSING);
    const malformed = await revoke(b, "not-a-uuid");
    for (const res of [foreign, unknown, malformed]) {
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe("key.not_found");
    }
    expect(foreign.body).toEqual(unknown.body);
    expect((await storedRow(mine.readKey.id)).revokedAt).toBeNull();
    expect((await probe("read", mine.key)).status).toBe(200);
  });

  it("cannot revoke an ingest key: it is a 404 and the key keeps working", async () => {
    const res = await revoke(a, a.ingestKeyId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("key.not_found");
    expect((await storedRow(a.ingestKeyId)).revokedAt).toBeNull();
    expect((await probe("ingest", a.ingestKey)).status).toBe(200);
  });

  it("is 401 without a session", async () => {
    expect((await http().get("/v1/keys")).status).toBe(401);
    expect((await http().post(`/v1/keys/${MISSING}/revoke`)).status).toBe(401);
  });
});

describe("ReadKeyGuard", () => {
  it("authenticates a valid key as its own user, with its scopes and restriction", async () => {
    const created = await mint(a, {
      scopes: ["events:read"],
      restriction: { sources: [a.integrationId], types: ["browser.*"] },
    });
    const res = await probe("read", created.key);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      kind: "read",
      userId: a.userId,
      keyId: created.readKey.id,
      scopes: ["events:read"],
      restriction: { sources: [a.integrationId], types: ["browser.*"] },
    });
  });

  it("has no restriction on an unrestricted key", async () => {
    const created = await mint(a);
    expect((await probe("read", created.key)).body.restriction).toBeNull();
  });

  it("is decided by the key alone: a smuggled user, or another user's cookie, changes nothing", async () => {
    const created = await mint(a);
    const res = await http()
      .post(`/probe/read?userId=${b.userId}`)
      .set("Authorization", `Bearer ${created.key}`)
      .set("Cookie", b.cookie)
      .set("X-User-Id", b.userId)
      .send({ userId: b.userId, scopes: ["activity:read"] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ userId: a.userId, scopes: ["events:read"] });
  });

  describe("refusals are all the same 401 (no oracle)", () => {
    async function cases(): Promise<Array<[string, () => ReturnType<typeof probe>]>> {
      const valid = await mint(a);
      const revoked = await mint(a);
      await revoke(a, revoked.readKey.id);

      const damaged = async (patch: Partial<typeof apiKeys.$inferInsert>) => {
        const key = generateApiKey("read");
        await testDb.db.insert(apiKeys).values({
          userId: a.userId,
          kind: "read",
          prefix: key.prefix,
          hash: key.hash,
          scopes: ["events:read"],
          ...patch,
        });
        return key.plaintext;
      };
      const badScopes = await damaged({ scopes: ["events:read", "admin"] });
      const notAnArray = await damaged({ scopes: { "events:read": true } });
      const badRestriction = await damaged({ restriction: { sources: ["not-a-uuid"] } });
      const emptyRestriction = await damaged({ restriction: {} });
      const widerRestriction = await damaged({ restriction: { userId: b.userId } });

      return [
        ["no Authorization header", () => probe("read")],
        ["unknown well-formed key", () => probe("read", generateApiKey("read").plaintext)],
        ["malformed key", () => probe("read", "pa_read_not-a-real-key")],
        ["truncated key", () => probe("read", valid.key.slice(0, 20))],
        [
          "altered last character",
          () => probe("read", `${valid.key.slice(0, -1)}${valid.key.endsWith("A") ? "B" : "A"}`),
        ],
        ["not a pa_ key at all", () => probe("read", "hello")],
        ["revoked key", () => probe("read", revoked.key)],
        ["a valid ingest key", () => probe("read", a.ingestKey)],
        ["a valid session cookie", () => http().get("/probe/read").set("Cookie", a.cookie)],
        [
          "wrong scheme",
          () => http().get("/probe/read").set("Authorization", `Basic ${valid.key}`),
        ],
        ["token without scheme", () => http().get("/probe/read").set("Authorization", valid.key)],
        ["key in the query string only", () => http().get("/probe/read").query({ key: valid.key })],
        [
          "key in a cookie only",
          () => http().get("/probe/read").set("Cookie", `pa_read=${valid.key}`),
        ],
        ["key in X-Api-Key only", () => http().get("/probe/read").set("X-Api-Key", valid.key)],
        ["stored scopes with an unknown entry", () => probe("read", badScopes)],
        ["stored scopes that are not an array", () => probe("read", notAnArray)],
        ["a stored restriction that does not parse", () => probe("read", badRestriction)],
        ["a stored restriction that is empty", () => probe("read", emptyRestriction)],
        ["a stored restriction with unknown keys", () => probe("read", widerRestriction)],
      ];
    }

    it("answers 401 application/problem+json auth.invalid_key for every reason", async () => {
      for (const [reason, send] of await cases()) {
        const res = await send();
        expect(res.status, reason).toBe(401);
        expect(res.headers["content-type"], reason).toMatch(PROBLEM_JSON);
        expect(res.body, reason).toMatchObject({ status: 401, code: "auth.invalid_key" });
      }
    });

    it("gives byte-identical bodies, and the same body as the ingest guard", async () => {
      const all = await cases();
      const baseline = await all[0]?.[1]();
      for (const [reason, send] of all) {
        expect((await send()).text, reason).toBe(baseline?.text);
      }
      expect((await probe("ingest")).text).toBe(baseline?.text);
    });

    it("does not echo the presented key", async () => {
      const key = generateApiKey("read").plaintext;
      const res = await probe("read", key);
      expect(res.text).not.toContain(key.slice("pa_read_".length));
      expect(JSON.stringify(res.headers)).not.toContain(key);
    });
  });

  describe("scopes", () => {
    it("lets a key with the route's scope in, and keeps a key without it out with 403", async () => {
      const events = await mint(a, { scopes: ["events:read"] });
      const activity = await mint(a, { scopes: ["activity:read"] });
      const both = await mint(a, { scopes: ["events:read", "activity:read"] });

      expect((await probe("read", events.key)).status).toBe(200);
      expect((await probe("read-activity", activity.key)).status).toBe(200);
      expect((await probe("read", both.key)).status).toBe(200);
      expect((await probe("read-activity", both.key)).status).toBe(200);

      for (const [path, key] of [
        ["read", activity.key],
        ["read-activity", events.key],
      ] as const) {
        const res = await probe(path, key);
        expect(res.status, path).toBe(403);
        expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
        expect(res.body.code).toBe("auth.insufficient_scope");
        expect(res.text).not.toContain(key);
      }
    });

    it("an endpoint-scoped key cannot call a route that needs events:read (no escalation)", async () => {
      const key = generateApiKey("read");
      await testDb.db.insert(apiKeys).values({
        userId: a.userId,
        kind: "read",
        prefix: key.prefix,
        hash: key.hash,
        scopes: [endpointScope(MISSING)],
      });
      expect((await probe("read", key.plaintext)).status).toBe(403);
      expect((await probe("read-activity", key.plaintext)).status).toBe(403);
    });

    it("a key with no scopes at all can call nothing", async () => {
      const key = generateApiKey("read");
      await testDb.db
        .insert(apiKeys)
        .values({ userId: a.userId, kind: "read", prefix: key.prefix, hash: key.hash });
      expect((await probe("read", key.plaintext)).status).toBe(403);
    });

    it("fails closed (500) on a route that declares no scope, for any caller", async () => {
      const created = await mint(a, { scopes: ["events:read", "activity:read"] });
      expect((await probe("read-no-scope", created.key)).status).toBe(500);
      expect((await probe("read-no-scope")).status).toBe(500);
    });
  });

  describe("credentials are not interchangeable", () => {
    it("a read key cannot pass IngestKeyGuard or SessionGuard", async () => {
      const created = await mint(a);
      const ingest = await probe("ingest", created.key);
      expect(ingest.status).toBe(401);
      expect(ingest.body.code).toBe("auth.invalid_key");
      const session = await http().get("/v1/me").set("Authorization", `Bearer ${created.key}`);
      expect(session.status).toBe(401);
      expect(session.body.code).toBe("auth.unauthenticated");
      const sessionProbe = await probe("session", created.key);
      expect(sessionProbe.status).toBe(401);
    });

    it("CurrentAuth fails closed (500) when a route behind ReadKeyGuard asks for a session", async () => {
      const created = await mint(a);
      expect((await probe("read-as-session", created.key)).status).toBe(500);
    });
  });

  describe("revocation and last use", () => {
    it("a revoked key goes from 200 to 401 on the very next request", async () => {
      const created = await mint(a);
      expect((await probe("read", created.key)).status).toBe(200);
      expect((await revoke(a, created.readKey.id)).status).toBe(200);
      const res = await probe("read", created.key);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("auth.invalid_key");
    });

    it("revoking one key leaves the user's other keys working", async () => {
      const first = await mint(a);
      const second = await mint(a);
      await revoke(a, first.readKey.id);
      expect((await probe("read", first.key)).status).toBe(401);
      expect((await probe("read", second.key)).status).toBe(200);
    });

    it("another user cannot revoke it, and it keeps working", async () => {
      const created = await mint(a);
      expect((await revoke(b, created.readKey.id)).status).toBe(404);
      expect((await probe("read", created.key)).status).toBe(200);
    });

    it("sets last_used_at from the clock, at most once per interval, and shows it in the list", async () => {
      const created = await mint(a);
      const t0 = new Date("2027-01-10T08:00:00.000Z");
      clock.set(t0);
      await probe("read", created.key);
      clock.set(new Date(t0.getTime() + LAST_USED_UPDATE_INTERVAL_MS - 1));
      await probe("read", created.key);
      expect((await storedRow(created.readKey.id)).lastUsedAt).toEqual(t0);
      const listed = readKeyListResponseSchema.parse((await list(a)).body).readKeys;
      expect(listed.find((k) => k.id === created.readKey.id)?.lastUsedAt).toBe(t0.toISOString());
    });

    it("a refused key does not touch last_used_at", async () => {
      const created = await mint(a, { scopes: ["activity:read"] });
      await probe("read", created.key); // valid key, wrong scope: 403
      const revoked = await mint(a);
      await revoke(a, revoked.readKey.id);
      await probe("read", revoked.key);
      expect((await storedRow(revoked.readKey.id)).lastUsedAt).toBeNull();
    });
  });

  describe("logs never contain keys or hashes (invariant 6)", () => {
    it("keeps a created key, a used key, a refused key and their hashes out of log output", async () => {
      const refused = generateApiKey("read");
      const capture = captureOutput();
      let output = "";
      let created: Awaited<ReturnType<typeof mint>>;
      try {
        created = await mint(a);
        await probe("read", created.key);
        await probe("read", refused.plaintext);
        await probe("read", "pa_read_malformed");
      } finally {
        output = capture.stop();
      }
      expect(output, "captured log output should include the request log lines").toContain(
        "statusCode",
      );
      for (const secret of [created.key, refused.plaintext]) {
        expect(output).not.toContain(secret);
        expect(output).not.toContain(secret.slice("pa_read_".length));
        expect(output).not.toContain(hashApiKey(secret));
      }
    });
  });
});
