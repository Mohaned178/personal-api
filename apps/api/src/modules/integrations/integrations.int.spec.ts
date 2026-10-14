/**
 * M1-04 integrations over HTTP against the real application (Testcontainers; CI runs these,
 * Docker may be off locally), using the two-user fixture and the test-only /probe routes.
 *
 * Covers: the key appears only in the create response (only its hash is stored), a revoked
 * integration's key is 401 on the very next request, 401 without a session, cross-tenant
 * get/rename/revoke are 404 and change nothing, unknown body keys are 400 `request.invalid`
 * without echoing input, create and revoke are atomic, and key creation and revoke are ordered
 * by a row lock (the M1-03 follow-up race).
 */
import type { INestApplication } from "@nestjs/common";
import {
  createIntegrationResponseSchema,
  integrationListResponseSchema,
  integrationResponseSchema,
} from "@personal-api/contracts";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureOutput } from "../../../test/auth.helpers";
import { FakeClock } from "../../../test/fake-clock";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { buildFixtureApp, type FixtureUser, seedTwoUsers } from "../../../test/two-user-fixture";
import { apiKeys, integrations } from "../../platform/db/schema";
import { ApiKeysService } from "../keys/api-keys.service";
import { generateApiKey, hashApiKey, INGEST_KEY_PATTERN } from "../keys/key-generation";
import { IntegrationsRepository } from "./integrations.repository";
import { IntegrationsService } from "./integrations.service";

const PROBLEM_JSON = /^application\/problem\+json/;
const SENTINEL = "sentinel-https://leak.example/secret?token=1";
const NOW = "2026-10-14T12:00:00.000Z";

let testDb: TestDatabase;
let app: INestApplication;
const clock = new FakeClock(NOW);
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
const as = (user: FixtureUser) => ({
  get: (path: string) => http().get(path).set("Cookie", user.cookie),
  post: (path: string, body?: unknown) =>
    http()
      .post(path)
      .set("Cookie", user.cookie)
      .send(body as object),
  patch: (path: string, body?: unknown) =>
    http()
      .patch(path)
      .set("Cookie", user.cookie)
      .send(body as object),
});
const probe = (key: string) => http().get("/probe/ingest").set("Authorization", `Bearer ${key}`);

async function createVia(user: FixtureUser, name: string) {
  const res = await as(user).post("/v1/integrations", { kind: "http", name });
  expect(res.status).toBe(201);
  return createIntegrationResponseSchema.parse(res.body);
}

async function integrationRow(id: string) {
  const [row] = await testDb.db.select().from(integrations).where(eq(integrations.id, id));
  return row;
}

async function keyRows(integrationId: string) {
  return testDb.db.select().from(apiKeys).where(eq(apiKeys.integrationId, integrationId));
}

describe("authentication", () => {
  it("answers 401 without a session on every route", async () => {
    const id = a.integrationId;
    const responses = await Promise.all([
      http().post("/v1/integrations").send({ kind: "http", name: "x" }),
      http().get("/v1/integrations"),
      http().get(`/v1/integrations/${id}`),
      http().patch(`/v1/integrations/${id}`).send({ name: "x" }),
      http().post(`/v1/integrations/${id}/revoke`),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe("auth.unauthenticated");
    }
  });

  it("answers 401 (not 400) for an invalid body without a session", async () => {
    const res = await http().post("/v1/integrations").send({ unknown: true });
    expect(res.status).toBe(401);
    const patch = await http().patch(`/v1/integrations/${a.integrationId}`).send({ bad: 1 });
    expect(patch.status).toBe(401);
  });

  it("does not accept an ingest key in place of a session", async () => {
    const res = await http().get("/v1/integrations").set("Authorization", `Bearer ${a.ingestKey}`);
    expect(res.status).toBe(401);
  });
});

describe("create", () => {
  it("returns the integration and its ingest key once, deny by default", async () => {
    const output = captureOutput();
    let res: request.Response;
    let logged = "";
    try {
      res = await as(a).post("/v1/integrations", { kind: "http", name: "  Home server  " });
    } finally {
      logged = output.stop();
    }
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = createIntegrationResponseSchema.parse(res.body);
    expect(body.integration).toMatchObject({
      kind: "http",
      name: "Home server",
      defaultPolicy: "deny",
      status: "active",
      lastSeenAt: null,
    });
    // created_at is the database's now(), not the injected clock.
    expect(Number.isNaN(Date.parse(body.integration.createdAt))).toBe(false);
    expect(body.ingestKey.key).toMatch(INGEST_KEY_PATTERN);
    expect(body.ingestKey.prefix).toBe(body.ingestKey.key.slice(0, body.ingestKey.prefix.length));
    expect(logged).not.toContain(body.ingestKey.key);

    // The returned key works, and it authenticates as this integration of this user.
    const used = await probe(body.ingestKey.key);
    expect(used.status).toBe(200);
    expect(used.body).toMatchObject({
      userId: a.userId,
      integrationId: body.integration.id,
      keyId: body.ingestKey.id,
    });
  });

  it("stores only the hash: the plaintext is nowhere in the database", async () => {
    const created = await createVia(a, "hash check");
    const rows = await keyRows(created.integration.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: created.ingestKey.id,
      userId: a.userId,
      kind: "ingest",
      hash: hashApiKey(created.ingestKey.key),
      prefix: created.ingestKey.prefix,
      revokedAt: null,
    });
    const everything = JSON.stringify([
      await testDb.db.select().from(apiKeys),
      await testDb.db.select().from(integrations),
    ]);
    expect(everything).not.toContain(created.ingestKey.key);
  });

  it("owns the new integration by the session user, whatever the body says", async () => {
    const created = await createVia(b, "mine");
    expect((await integrationRow(created.integration.id))?.userId).toBe(b.userId);
    const smuggled = await as(a).post("/v1/integrations", {
      kind: "http",
      name: "x",
      userId: b.userId,
    });
    expect(smuggled.status).toBe(400);
  });

  it.each([
    ["an unknown key", { kind: "http", name: "x", extra: 1 }],
    ["userId", { kind: "http", name: "x", userId: "someone" }],
    ["defaultPolicy", { kind: "http", name: "x", defaultPolicy: "allow" }],
    ["status", { kind: "http", name: "x", status: "revoked" }],
    ["integrationId", { kind: "http", name: "x", integrationId: "i" }],
    ["the browser-extension kind", { kind: "browser-extension", name: "x" }],
    ["a blank name", { kind: "http", name: "   " }],
    ["a missing kind", { name: "x" }],
    ["a non-object body", ["x"]],
  ])("rejects %s with 400 request.invalid and creates nothing", async (_label, body) => {
    const before = (await testDb.db.select().from(integrations)).length;
    const res = await as(a).post("/v1/integrations", body);
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body).toMatchObject({ status: 400, code: "request.invalid" });
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect((await testDb.db.select().from(integrations)).length).toBe(before);
  });

  it("never echoes input back in a validation error, or into the logs", async () => {
    const output = captureOutput();
    const responses: request.Response[] = [];
    let logged = "";
    try {
      responses.push(
        await as(a).post("/v1/integrations", { kind: "http", name: "x", [SENTINEL]: 1 }),
        await as(a).post("/v1/integrations", { kind: "http", name: SENTINEL.repeat(5) }),
        await as(a).post("/v1/integrations", { kind: SENTINEL, name: 5 }),
        await as(a).patch(`/v1/integrations/${a.integrationId}`, { name: { [SENTINEL]: 1 } }),
      );
    } finally {
      logged = output.stop();
    }
    for (const res of responses) {
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("request.invalid");
      expect(JSON.stringify(res.body)).not.toContain("leak.example");
    }
    expect(logged).not.toContain("leak.example");
  });

  it("is atomic: a failing key insert leaves no integration behind", async () => {
    const repository = app.get(IntegrationsRepository);
    const key = generateApiKey("ingest");
    const first = await repository.createHttp(
      a.userId,
      { name: "atomic-1" },
      { prefix: key.prefix, hash: key.hash },
    );
    const before = (await testDb.db.select().from(integrations)).length;
    // Same hash: the unique index on api_keys.hash fails the second key insert.
    await expect(
      repository.createHttp(a.userId, { name: "atomic-2" }, { prefix: key.prefix, hash: key.hash }),
    ).rejects.toThrow();
    expect((await testDb.db.select().from(integrations)).length).toBe(before);
    expect(await keyRows(first.integration.id)).toHaveLength(1);
  });
});

describe("list and get", () => {
  it("lists only the caller's integrations, never a key or a hash", async () => {
    const created = await createVia(a, "listed");
    const res = await as(a).get("/v1/integrations");
    expect(res.status).toBe(200);
    const body = integrationListResponseSchema.parse(res.body);
    const ids = body.integrations.map((integration) => integration.id);
    expect(ids).toContain(created.integration.id);
    expect(ids).toContain(a.integrationId);
    expect(ids).not.toContain(b.integrationId);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("pa_ing_");
    expect(raw).not.toContain(created.ingestKey.key);
    expect(raw).not.toContain(hashApiKey(created.ingestKey.key));
    for (const item of body.integrations) {
      expect(Object.keys(item).sort()).toEqual([
        "createdAt",
        "defaultPolicy",
        "id",
        "kind",
        "lastSeenAt",
        "name",
        "status",
      ]);
    }

    const theirs = integrationListResponseSchema.parse((await as(b).get("/v1/integrations")).body);
    expect(theirs.integrations.map((integration) => integration.id)).not.toContain(a.integrationId);
  });

  it("gets one integration without any key material", async () => {
    const created = await createVia(a, "get me");
    const res = await as(a).get(`/v1/integrations/${created.integration.id}`);
    expect(res.status).toBe(200);
    expect(integrationResponseSchema.parse(res.body).integration).toEqual(created.integration);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(created.ingestKey.key);
    expect(raw).not.toContain(hashApiKey(created.ingestKey.key));
    expect(raw).not.toContain("pa_ing_");
  });
});

describe("rename", () => {
  it("renames (trimmed) and changes nothing else", async () => {
    const created = await createVia(a, "before");
    const res = await as(a).patch(`/v1/integrations/${created.integration.id}`, {
      name: "  after  ",
    });
    expect(res.status).toBe(200);
    expect(integrationResponseSchema.parse(res.body).integration).toEqual({
      ...created.integration,
      name: "after",
    });
    expect((await keyRows(created.integration.id))[0]?.revokedAt).toBeNull();
  });

  it.each([
    ["an unknown key", { name: "x", extra: 1 }],
    ["kind", { name: "x", kind: "http" }],
    ["status", { status: "active" }],
    ["defaultPolicy", { name: "x", defaultPolicy: "allow" }],
    ["userId", { name: "x", userId: "u" }],
    ["an empty body", {}],
    ["an empty name", { name: "" }],
  ])("rejects %s with 400 request.invalid", async (_label, body) => {
    const before = (await integrationRow(a.integrationId))?.name;
    const res = await as(a).patch(`/v1/integrations/${a.integrationId}`, body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("request.invalid");
    expect((await integrationRow(a.integrationId))?.name).toBe(before);
  });
});

describe("revoke", () => {
  it("revokes the integration and its key; the key is 401 on the very next request", async () => {
    const created = await createVia(a, "to revoke");
    expect((await probe(created.ingestKey.key)).status).toBe(200);

    clock.set("2026-10-14T13:00:00.000Z");
    const res = await as(a).post(`/v1/integrations/${created.integration.id}/revoke`);
    expect(res.status).toBe(200);
    expect(integrationResponseSchema.parse(res.body).integration).toMatchObject({
      id: created.integration.id,
      status: "revoked",
    });

    const after = await probe(created.ingestKey.key);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe("auth.invalid_key");
    expect((await integrationRow(created.integration.id))?.status).toBe("revoked");
    expect((await keyRows(created.integration.id)).map((row) => row.revokedAt)).toEqual([
      new Date("2026-10-14T13:00:00.000Z"),
    ]);
  });

  it("is idempotent and keeps the first revocation time", async () => {
    const created = await createVia(a, "twice");
    clock.set("2026-10-14T14:00:00.000Z");
    expect((await as(a).post(`/v1/integrations/${created.integration.id}/revoke`)).status).toBe(
      200,
    );
    clock.set("2026-10-14T15:00:00.000Z");
    const again = await as(a).post(`/v1/integrations/${created.integration.id}/revoke`);
    expect(again.status).toBe(200);
    expect(again.body.integration.status).toBe("revoked");
    expect((await keyRows(created.integration.id)).map((row) => row.revokedAt)).toEqual([
      new Date("2026-10-14T14:00:00.000Z"),
    ]);
  });

  it("revokes every key of the integration, and only that integration's", async () => {
    const target = await createVia(a, "target");
    const sibling = await createVia(a, "sibling");
    const extra = await app.get(ApiKeysService).createIngestKey(a.userId, target.integration.id);
    expect((await probe(extra.key)).status).toBe(200);

    await as(a).post(`/v1/integrations/${target.integration.id}/revoke`);

    expect((await probe(target.ingestKey.key)).status).toBe(401);
    expect((await probe(extra.key)).status).toBe(401);
    expect((await probe(sibling.ingestKey.key)).status).toBe(200);
    expect((await probe(b.ingestKey)).status).toBe(200);
    expect((await keyRows(target.integration.id)).every((row) => row.revokedAt !== null)).toBe(
      true,
    );
  });

  it("refuses to add a key to a revoked integration", async () => {
    const created = await createVia(a, "no new keys");
    await as(a).post(`/v1/integrations/${created.integration.id}/revoke`);
    await expect(
      app.get(ApiKeysService).createIngestKey(a.userId, created.integration.id),
    ).rejects.toMatchObject({ code: "integration.not_found" });
    expect(await keyRows(created.integration.id)).toHaveLength(1);
  });

  it("can still be listed and renamed afterwards, but there is no way to delete it", async () => {
    const created = await createVia(a, "history");
    await as(a).post(`/v1/integrations/${created.integration.id}/revoke`);
    const list = integrationListResponseSchema.parse((await as(a).get("/v1/integrations")).body);
    expect(list.integrations.find((i) => i.id === created.integration.id)?.status).toBe("revoked");
    const del = await http()
      .delete(`/v1/integrations/${created.integration.id}`)
      .set("Cookie", a.cookie);
    expect(del.status).toBe(404);
    expect(await integrationRow(created.integration.id)).toBeDefined();
  });
});

describe("cross-tenant isolation", () => {
  const missing = "0192f1c2-7c1e-7a3b-9f00-000000000000";

  it("answers 404 for get, rename and revoke of another user's integration, changing nothing", async () => {
    const before = await integrationRow(a.integrationId);
    const keysBefore = await keyRows(a.integrationId);

    const responses = [
      await as(b).get(`/v1/integrations/${a.integrationId}`),
      await as(b).patch(`/v1/integrations/${a.integrationId}`, { name: "hijacked" }),
      await as(b).post(`/v1/integrations/${a.integrationId}/revoke`),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe("integration.not_found");
    }

    expect(await integrationRow(a.integrationId)).toEqual(before);
    expect(await keyRows(a.integrationId)).toEqual(keysBefore);
    expect((await probe(a.ingestKey)).status).toBe(200);
  });

  it("gives the same 404 as for an unknown or malformed id, so existence is not revealed", async () => {
    const foreign = await as(b).get(`/v1/integrations/${a.integrationId}`);
    for (const id of [missing, "not-a-uuid", "1", "%27%20or%201%3D1"]) {
      const res = await as(b).get(`/v1/integrations/${id}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(foreign.body);
    }
    for (const id of [missing, "not-a-uuid"]) {
      expect((await as(b).patch(`/v1/integrations/${id}`, { name: "x" })).status).toBe(404);
      expect((await as(b).post(`/v1/integrations/${id}/revoke`)).status).toBe(404);
    }
  });

  it("cannot be bypassed by naming the owner in the request", async () => {
    const res = await as(b).patch(`/v1/integrations/${a.integrationId}`, {
      name: "x",
      userId: a.userId,
    });
    expect(res.status).toBe(400);
    expect((await integrationRow(a.integrationId))?.name).toBe("fixture-a");
  });
});

describe("revoke and key creation are ordered by a row lock", () => {
  async function waitForBlockedBackend(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { rows } = await testDb.pool.query<{ n: string }>(
        "select count(*)::text as n from pg_stat_activity where wait_event_type = 'Lock'",
      );
      if (Number(rows[0]?.n) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("no backend ever waited on a lock");
  }

  it("a revoke waits for an in-flight key insert, then revokes that new key too", async () => {
    const created = await createVia(a, "race: key first");
    const raceKey = generateApiKey("ingest");
    const client = await testDb.pool.connect();
    try {
      await client.query("begin");
      // What ApiKeysRepository.insertIngestKey does first: read the integration FOR SHARE.
      await client.query("select id from integrations where id = $1 for share", [
        created.integration.id,
      ]);

      let revoked = false;
      const revoking = app
        .get(IntegrationsService)
        .revoke(a.userId, created.integration.id)
        .then((result) => {
          revoked = true;
          return result;
        });
      await waitForBlockedBackend();
      expect(revoked).toBe(false);

      await client.query(
        "insert into api_keys (user_id, kind, integration_id, prefix, hash) values ($1, 'ingest', $2, $3, $4)",
        [a.userId, created.integration.id, raceKey.prefix, raceKey.hash],
      );
      await client.query("commit");

      expect((await revoking).integration.status).toBe("revoked");
      const rows = await keyRows(created.integration.id);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
      expect((await probe(raceKey.plaintext)).status).toBe(401);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("a key insert waits for an in-flight revoke, then stores nothing", async () => {
    const created = await createVia(a, "race: revoke first");
    const client = await testDb.pool.connect();
    try {
      await client.query("begin");
      await client.query("update integrations set status = 'revoked' where id = $1", [
        created.integration.id,
      ]);

      let settled = false;
      const inserting = app
        .get(ApiKeysService)
        .createIngestKey(a.userId, created.integration.id)
        .finally(() => {
          settled = true;
        });
      const outcome = inserting.then(
        () => "created",
        (error: { code?: string }) => error.code,
      );
      await waitForBlockedBackend();
      expect(settled).toBe(false);

      await client.query("commit");
      expect(await outcome).toBe("integration.not_found");
      expect(await keyRows(created.integration.id)).toHaveLength(1);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });
});
