/**
 * M5-05 endpoints over HTTP against the real application (Testcontainers; CI runs these, Docker may
 * be off locally): CRUD under /v1/endpoints, the preview, the scoped key minted with the endpoint,
 * and `GET /v1/me/:slug`. Fixed clock: FIXED_NOW (2026-10-14T12:00Z). The cross-tenant attacks are
 * in the sweep (integrations/cross-tenant-sweep.int.spec.ts); the injection and limit attacks are M5-06.
 */
import {
  endpointKeyResponseSchema,
  endpointListResponseSchema,
  endpointResponseSchema,
  previewEndpointResponseSchema,
  savedQueryResultSchema,
} from "@personal-api/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  expectResults,
  type IngestHarness,
  PROBLEM_JSON,
  pageVisit,
  postEvents,
  startIngestHarness,
} from "../../../test/ingest-helpers";
import type { FixtureUser } from "../../../test/two-user-fixture";
import { hashApiKey } from "../keys/key-generation";

let h: IngestHarness;

beforeAll(async () => {
  h = await startIngestHarness();
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.reset();
});

const http = () => request(h.app.getHttpServer());
const post = (u: FixtureUser, path: string, body?: unknown) =>
  http()
    .post(path)
    .set("Cookie", u.cookie)
    .send(body as object);
const put = (u: FixtureUser, path: string, body: unknown) =>
  http()
    .put(path)
    .set("Cookie", u.cookie)
    .send(body as object);
const get = (u: FixtureUser, path: string) => http().get(path).set("Cookie", u.cookie);
const me = (slug: string, key?: string) => {
  const req = http().get(`/v1/me/${slug}`);
  return key ? req.set("Authorization", `Bearer ${key}`) : req;
};

const countByDay = {
  when: { type: ["browser.page_visited"] },
  window: { kind: "last_n_days", days: 7 },
  aggregate: "count_by_day",
};
const body = (slug: string, extra: object = {}) => ({ slug, definition: countByDay, ...extra });

async function create(user: FixtureUser, slug: string, extra: object = {}) {
  const res = await post(user, "/v1/endpoints", body(slug, extra));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return endpointKeyResponseSchema.parse(res.body);
}

describe("POST /v1/endpoints", () => {
  it("creates the endpoint and a key scoped to it, shown once and stored as a hash", async () => {
    const res = await post(h.a, "/v1/endpoints", body("stats"));
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const created = endpointKeyResponseSchema.parse(res.body);
    expect(created.key).toMatch(/^pa_read_[A-Za-z0-9_-]{43}$/);
    expect(created.endpoint).toMatchObject({ slug: "stats", enabled: true });

    const { rows } = await h.testDb.pool.query(
      "select user_id, kind, endpoint_id, integration_id, scopes, hash, revoked_at from api_keys where endpoint_id = $1",
      [created.endpoint.id],
    );
    expect(rows).toEqual([
      {
        user_id: h.a.userId,
        kind: "read",
        endpoint_id: created.endpoint.id,
        integration_id: null,
        scopes: [`endpoint:${created.endpoint.id}`],
        hash: hashApiKey(created.key),
        revoked_at: null,
      },
    ]);

    const listed = await get(h.a, "/v1/endpoints");
    const fetched = await get(h.a, `/v1/endpoints/${created.endpoint.id}`);
    for (const out of [listed, fetched]) {
      expect(JSON.stringify(out.body)).not.toContain(created.key);
      expect(JSON.stringify(out.body)).not.toContain(hashApiKey(created.key));
    }
  });

  it("the same slug is fine for another user and a 409 for the same user", async () => {
    await create(h.a, "stats");
    await create(h.b, "stats");
    const again = await post(h.a, "/v1/endpoints", body("stats"));
    expect(again.status).toBe(409);
    expect(again.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(again.body.code).toBe("endpoint.slug_taken");
    const { rows } = await h.testDb.pool.query(
      "select count(*)::int as n from endpoints where user_id = $1",
      [h.a.userId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("is a 409 endpoint.limit_reached at 50 endpoints, with nothing stored", async () => {
    for (let i = 0; i < 50; i += 1) await create(h.a, `e-${i}`);
    const res = await post(h.a, "/v1/endpoints", body("one-more"));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("endpoint.limit_reached");
    const { rows } = await h.testDb.pool.query(
      "select count(*)::int as n from api_keys where endpoint_id is not null and user_id = $1",
      [h.a.userId],
    );
    expect(rows[0].n).toBe(50);
  });

  it.each([
    ["a bad slug", { slug: "Bad Slug" }],
    ["an invalid definition", { definition: { ...countByDay, fields: ["type"] } }],
    ["an unknown key", { id: "0192f1c2-7c1e-7a3b-9f00-000000000000" }],
    ["a userId", { userId: "someone" }],
    ["a key", { key: "pa_read_x" }],
  ])("rejects %s with 400 request.invalid and stores nothing", async (_label, extra) => {
    const res = await post(h.a, "/v1/endpoints", { ...body("ok"), ...extra });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("request.invalid");
    const { rows } = await h.testDb.pool.query("select count(*)::int as n from endpoints");
    expect(rows[0].n).toBe(0);
  });

  it("needs a session", async () => {
    const res = await http().post("/v1/endpoints").send(body("x"));
    expect(res.status).toBe(401);
  });
});

describe("PUT, DELETE and rotate-key", () => {
  it("replaces the whole endpoint, including the slug, and keeps the same key working", async () => {
    const created = await create(h.a, "stats");
    const res = await put(h.a, `/v1/endpoints/${created.endpoint.id}`, {
      ...body("renamed"),
      enabled: false,
    });
    expect(res.status).toBe(200);
    const updated = endpointResponseSchema.parse(res.body).endpoint;
    expect(updated).toMatchObject({ id: created.endpoint.id, slug: "renamed", enabled: false });
    expect(updated.updatedAt >= updated.createdAt).toBe(true);

    // Disabled endpoints do not run for readers; enabling it again is an explicit change.
    expect((await me("renamed", created.key)).status).toBe(404);
    await put(h.a, `/v1/endpoints/${created.endpoint.id}`, body("renamed", { enabled: true }));
    expect((await me("renamed", created.key)).status).toBe(200);
  });

  it("a replacement without enabled is a 400 and does not re-enable a disabled endpoint", async () => {
    const created = await create(h.a, "stats", { enabled: false });
    const res = await put(h.a, `/v1/endpoints/${created.endpoint.id}`, body("stats"));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("request.invalid");
    const { rows } = await h.testDb.pool.query("select enabled from endpoints where id = $1", [
      created.endpoint.id,
    ]);
    expect(rows[0].enabled).toBe(false);
  });

  it("refuses a slug the user already uses on another endpoint", async () => {
    await create(h.a, "one");
    const two = await create(h.a, "two");
    const res = await put(h.a, `/v1/endpoints/${two.endpoint.id}`, body("one", { enabled: true }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("endpoint.slug_taken");
  });

  it("deleting an endpoint deletes its keys, and the key stops working", async () => {
    const created = await create(h.a, "stats");
    expect((await me("stats", created.key)).status).toBe(200);
    const res = await http()
      .delete(`/v1/endpoints/${created.endpoint.id}`)
      .set("Cookie", h.a.cookie);
    expect(res.status).toBe(200);
    expect(endpointResponseSchema.parse(res.body).endpoint.id).toBe(created.endpoint.id);
    const { rows } = await h.testDb.pool.query(
      "select count(*)::int as n from api_keys where endpoint_id = $1",
      [created.endpoint.id],
    );
    expect(rows[0].n).toBe(0);
    const after = await me("stats", created.key);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe("auth.invalid_key");
  });

  it("rotating revokes the old key at the clock time and mints one new active key", async () => {
    const created = await create(h.a, "stats");
    h.clock.set("2026-10-14T13:00:00.000Z");
    const res = await post(h.a, `/v1/endpoints/${created.endpoint.id}/rotate-key`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const rotated = endpointKeyResponseSchema.parse(res.body);
    expect(rotated.key).not.toBe(created.key);

    const old = await me("stats", created.key);
    expect(old.status).toBe(401);
    expect(old.body.code).toBe("auth.invalid_key");
    expect((await me("stats", rotated.key)).status).toBe(200);

    const { rows } = await h.testDb.pool.query(
      "select revoked_at from api_keys where endpoint_id = $1 order by created_at, id",
      [created.endpoint.id],
    );
    expect(rows).toHaveLength(2);
    expect(rows.filter((r: { revoked_at: Date | null }) => r.revoked_at === null)).toHaveLength(1);
    expect(
      rows.find((r: { revoked_at: Date | null }) => r.revoked_at !== null).revoked_at.toISOString(),
    ).toBe("2026-10-14T13:00:00.000Z");
  });

  describe("concurrent rotation", () => {
    const rotate = (id: string) => post(h.a, `/v1/endpoints/${id}/rotate-key`);
    const activeKeys = async (id: string) =>
      (
        await h.testDb.pool.query(
          "select count(*)::int as n from api_keys where endpoint_id = $1 and revoked_at is null",
          [id],
        )
      ).rows[0].n as number;
    const stillPending = async (promise: Promise<unknown>) => {
      let settled = false;
      promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      return !settled;
    };

    it("many rotations at once leave exactly one active key", async () => {
      const created = await create(h.a, "stats");
      const results = await Promise.all(
        Array.from({ length: 8 }, () => rotate(created.endpoint.id)),
      );
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
      expect(await activeKeys(created.endpoint.id)).toBe(1);
      // Exactly one of the keys that were handed out still works.
      const keys = results.map((r) => endpointKeyResponseSchema.parse(r.body).key);
      const statuses = await Promise.all(keys.map(async (key) => (await me("stats", key)).status));
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    }, 30_000);

    it("a rotation waits for the endpoint row, so it cannot interleave with another change", async () => {
      const created = await create(h.a, "stats");
      const holder = await h.testDb.pool.connect();
      try {
        await holder.query("begin");
        // NO KEY UPDATE, not UPDATE: inserting the new key already takes a KEY SHARE lock on the
        // row (its foreign key), which UPDATE would block. This one only blocks a FOR UPDATE.
        await holder.query("select id from endpoints where id = $1 for no key update", [
          created.endpoint.id,
        ]);
        const pending = rotate(created.endpoint.id).then((r) => r);
        expect(await stillPending(pending)).toBe(true);
        await holder.query("commit");
        expect((await pending).status).toBe(200);
      } finally {
        // Whatever happened above, never leave the lock held for the next test.
        await holder.query("rollback").catch(() => undefined);
        holder.release();
      }
      expect(await activeKeys(created.endpoint.id)).toBe(1);
    }, 30_000);

    it("a rotation that races a delete is a 404, never a 500 from the key's foreign key", async () => {
      const created = await create(h.a, "stats");
      const holder = await h.testDb.pool.connect();
      try {
        await holder.query("begin");
        await holder.query("delete from endpoints where id = $1", [created.endpoint.id]);
        const pending = rotate(created.endpoint.id).then((r) => r);
        expect(await stillPending(pending)).toBe(true);
        await holder.query("commit");
        const res = await pending;
        expect(res.status, JSON.stringify(res.body)).toBe(404);
        expect(res.body.code).toBe("endpoint.not_found");
      } finally {
        // Whatever happened above, never leave the lock held for the next test.
        await holder.query("rollback").catch(() => undefined);
        holder.release();
      }
      const { rows } = await h.testDb.pool.query(
        "select count(*)::int as n from api_keys where endpoint_id = $1",
        [created.endpoint.id],
      );
      expect(rows[0].n).toBe(0);
    }, 30_000);
  });

  it("an unknown or malformed id is a 404 endpoint.not_found", async () => {
    for (const id of ["0192f1c2-7c1e-7a3b-9f00-000000000000", "not-a-uuid"]) {
      for (const res of [
        await get(h.a, `/v1/endpoints/${id}`),
        await put(h.a, `/v1/endpoints/${id}`, body("x", { enabled: true })),
        await http().delete(`/v1/endpoints/${id}`).set("Cookie", h.a.cookie),
        await post(h.a, `/v1/endpoints/${id}/rotate-key`),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe("endpoint.not_found");
      }
    }
  });

  it("lists the user's endpoints by slug", async () => {
    await create(h.a, "b-second");
    await create(h.a, "a-first");
    await create(h.b, "other");
    const res = await get(h.a, "/v1/endpoints");
    expect(endpointListResponseSchema.parse(res.body).endpoints.map((e) => e.slug)).toEqual([
      "a-first",
      "b-second",
    ]);
  });
});

describe("POST /v1/endpoints/preview", () => {
  it("runs an unsaved definition for the session user and stores nothing", async () => {
    expectResults(await postEvents(h.app, h.a.ingestKey, [pageVisit()]));
    expectResults(await postEvents(h.app, h.b.ingestKey, [pageVisit(), pageVisit()]));
    const res = await post(h.a, "/v1/endpoints/preview", { definition: countByDay });
    expect(res.status).toBe(200);
    const { result } = previewEndpointResponseSchema.parse(res.body);
    expect(result).toEqual({
      kind: "count_by_day",
      rows: [{ date: "2026-10-14", count: 1 }],
      truncated: false,
    });
    const { rows } = await h.testDb.pool.query("select count(*)::int as n from endpoints");
    expect(rows[0].n).toBe(0);
  });

  it("rejects an invalid definition with 400, and a session is required", async () => {
    const bad = await post(h.a, "/v1/endpoints/preview", {
      definition: { ...countByDay, fields: ["type"] },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("request.invalid");
    expect(
      (await http().post("/v1/endpoints/preview").send({ definition: countByDay })).status,
    ).toBe(401);
  });
});

describe("GET /v1/me/:slug", () => {
  it("returns the saved query's result for the key's owner, uncached", async () => {
    expectResults(await postEvents(h.app, h.a.ingestKey, [pageVisit(), pageVisit()]));
    expectResults(await postEvents(h.app, h.b.ingestKey, [pageVisit()]));
    const created = await create(h.a, "stats");
    const res = await me("stats", created.key);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(savedQueryResultSchema.parse(res.body)).toEqual({
      kind: "count_by_day",
      rows: [{ date: "2026-10-14", count: 2 }],
      truncated: false,
    });
    const { rows } = await h.testDb.pool.query(
      "select last_used_at from api_keys where endpoint_id = $1",
      [created.endpoint.id],
    );
    expect(rows[0].last_used_at).not.toBeNull();
  });

  it("an aggregate endpoint never returns raw events", async () => {
    expectResults(await postEvents(h.app, h.a.ingestKey, [pageVisit()]));
    const created = await create(h.a, "stats");
    const res = await me("stats", created.key);
    expect(JSON.stringify(res.body)).not.toContain("example.com");
    expect(JSON.stringify(res.body)).not.toContain("/docs/intro");
  });

  it("returns the projected fields of a raw-events endpoint", async () => {
    expectResults(await postEvents(h.app, h.a.ingestKey, [pageVisit()]));
    const created = await create(h.a, "visits", {
      definition: {
        when: { type: ["browser.page_visited"] },
        window: { kind: "last_n_days", days: 7 },
        fields: ["data.domain"],
      },
    });
    const res = await me("visits", created.key);
    expect(res.body).toEqual({
      kind: "events",
      rows: [{ domain: "example.com" }],
      truncated: false,
    });
  });

  it("a disabled endpoint is a 404 until it is enabled again", async () => {
    const created = await create(h.a, "stats", { enabled: false });
    const res = await me("stats", created.key);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("endpoint.not_found");
    await put(h.a, `/v1/endpoints/${created.endpoint.id}`, body("stats", { enabled: true }));
    expect((await me("stats", created.key)).status).toBe(200);
  });

  it("an unknown slug and a malformed slug are the same 404", async () => {
    const created = await create(h.a, "stats");
    const unknown = await me("nope", created.key);
    const malformed = await me("..%2Fx", created.key);
    for (const res of [unknown, malformed]) {
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe("endpoint.not_found");
    }
  });

  it("a stored definition that no longer parses is a 409 saved_query.definition_invalid", async () => {
    const created = await create(h.a, "stats");
    await h.testDb.pool.query("update endpoints set definition = $1::jsonb where id = $2", [
      JSON.stringify({ when: {}, window: { kind: "forever" } }),
      created.endpoint.id,
    ]);
    const res = await me("stats", created.key);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("saved_query.definition_invalid");
  });

  it("a stored time zone that Postgres does not know is a 409, for the endpoint and the preview", async () => {
    const created = await create(h.a, "stats");
    await h.testDb.pool.query(`update "user" set time_zone = $1 where id = $2`, [
      "Asia/Calcutta",
      h.a.userId,
    ]);
    const run = await me("stats", created.key);
    expect(run.status, JSON.stringify(run.body)).toBe(409);
    expect(run.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(run.body.code).toBe("settings.time_zone_unsupported");
    const preview = await post(h.a, "/v1/endpoints/preview", { definition: countByDay });
    expect(preview.status).toBe(409);
    expect(preview.body.code).toBe("settings.time_zone_unsupported");
    // Another user is not affected.
    expect((await post(h.b, "/v1/endpoints/preview", { definition: countByDay })).status).toBe(200);
  });

  describe("credentials and scope", () => {
    it("no credential, a session cookie, or a non-key bearer is refused", async () => {
      await create(h.a, "stats");
      expect((await me("stats")).status).toBe(401);
      const cookie = await http().get("/v1/me/stats").set("Cookie", h.a.cookie);
      expect(cookie.status).toBe(401);
      expect(cookie.body.code).toBe("auth.invalid_key");
      const ingest = await me("stats", h.a.ingestKey);
      expect(ingest.status).toBe(401);
      expect(ingest.body.code).toBe("auth.invalid_key");
    });

    it("a general read key (events:read, activity:read) cannot run an endpoint", async () => {
      await create(h.a, "stats");
      const minted = await post(h.a, "/v1/keys", { scopes: ["events:read", "activity:read"] });
      const res = await me("stats", minted.body.key);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("endpoint.not_found");
    });

    it("an endpoint key cannot run another endpoint of the same user, and it looks like a missing slug", async () => {
      const one = await create(h.a, "one");
      await create(h.a, "two");
      const res = await me("two", one.key);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("endpoint.not_found");
      // Byte for byte the answer for a slug that does not exist: no way to probe for slugs.
      const missing = await me("no-such-slug", one.key);
      expect(missing.status).toBe(404);
      expect(res.body).toEqual(missing.body);
    });

    it("a disabled endpoint answers the same 404 as an out-of-scope or missing one", async () => {
      const one = await create(h.a, "one", { enabled: false });
      const res = await me("one", one.key);
      expect(res.status).toBe(404);
      expect(res.body).toEqual((await me("no-such-slug", one.key)).body);
    });

    it("an endpoint key cannot call /v1/events or the activity routes", async () => {
      const created = await create(h.a, "stats");
      for (const path of ["/v1/events", "/v1/activity/daily", "/v1/activity/domains"]) {
        const res = await http().get(path).set("Authorization", `Bearer ${created.key}`);
        expect(res.status, path).toBe(403);
        expect(res.body.code).toBe("auth.insufficient_scope");
      }
    });

    it("an endpoint key cannot be used to manage endpoints or keys", async () => {
      const created = await create(h.a, "stats");
      for (const path of ["/v1/endpoints", "/v1/keys"]) {
        const res = await http().get(path).set("Authorization", `Bearer ${created.key}`);
        expect(res.status, path).toBe(401);
      }
    });

    it("a key revoked through /v1/keys stops working", async () => {
      const created = await create(h.a, "stats");
      const { rows } = await h.testDb.pool.query("select id from api_keys where endpoint_id = $1", [
        created.endpoint.id,
      ]);
      const revoked = await post(h.a, `/v1/keys/${rows[0].id}/revoke`);
      expect(revoked.status).toBe(200);
      expect((await me("stats", created.key)).status).toBe(401);
    });
  });
});
