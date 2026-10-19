/**
 * M5-06 adversarial tests for saved queries over HTTP against the real application (Testcontainers;
 * CI runs these, Docker may be off locally): injection through field names and values, the row
 * limit and the 2-second timeout, scope escalation with an endpoint key, and cross-tenant reads.
 * The compiler's own injection table (no database) is saved-query.injection.spec.ts, and the basic
 * routes are endpoints.int.spec.ts. Fixed clock: FIXED_NOW (2026-10-14T12:00Z).
 */
import { randomUUID } from "node:crypto";
import { endpointKeyResponseSchema } from "@personal-api/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tenantState } from "../../../test/adversarial-helpers";
import { type IngestHarness, PROBLEM_JSON, startIngestHarness } from "../../../test/ingest-helpers";
import type { FixtureUser } from "../../../test/two-user-fixture";

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

const TOKEN = "PAYLOAD7f3a";
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
const me = (slug: string, key: string) =>
  http().get(`/v1/me/${slug}`).set("Authorization", `Bearer ${key}`);

const countByDay = {
  when: { type: ["browser.page_visited"] },
  window: { kind: "last_n_days", days: 7 },
  aggregate: "count_by_day",
};
const paths = {
  when: { type: ["browser.page_visited"] },
  window: { kind: "last_n_days", days: 7 },
  fields: ["data.path"],
};

async function create(user: FixtureUser, slug: string, definition: object = countByDay) {
  const res = await post(user, "/v1/endpoints", { slug, definition });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return endpointKeyResponseSchema.parse(res.body);
}

/** Inserts straight into `events`, so the stored text is exactly what the test says. */
async function seed(
  user: FixtureUser,
  data: Record<string, unknown>,
  at = "2026-10-14T08:00:00.000Z",
  type = "browser.page_visited",
) {
  await h.testDb.pool.query(
    `insert into events (user_id, integration_id, client_event_id, type, type_version, occurred_at, data)
     values ($1, $2, $3, $4, 1, $5, $6::jsonb)`,
    [user.userId, user.integrationId, randomUUID(), type, at, JSON.stringify(data)],
  );
}

async function eventCounts(): Promise<Record<string, number>> {
  const { rows } = await h.testDb.pool.query<{ user_id: string; n: number }>(
    "select user_id, count(*)::int as n from events group by user_id",
  );
  return Object.fromEntries(rows.map((r) => [r.user_id, r.n]));
}

async function endpointCount(): Promise<number> {
  const { rows } = await h.testDb.pool.query("select count(*)::int as n from endpoints");
  return rows[0].n;
}

const projected = (res: { body: { rows?: Array<Record<string, unknown>> } }, key: string) =>
  (res.body.rows ?? []).map((row) => row[key]).sort();

describe("injection through values", () => {
  const hostile = {
    quote: "/q'; drop table events; --",
    percent: "/50%",
    underscore: "/a_b",
    backslash: "/a\\b",
  };
  const decoys = ["/50x", "/axb", "/plain", "/q"];

  beforeEach(async () => {
    for (const path of [...Object.values(hostile), ...decoys]) {
      await seed(h.a, { domain: "a.test", path });
    }
    // The victim owns events with the very same text: they must never be returned to the attacker.
    for (const path of Object.values(hostile)) await seed(h.b, { domain: "b.test", path });
  });

  const previewRows = async (when: object) => {
    const res = await post(h.a, "/v1/endpoints/preview", { definition: { ...paths, when } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return projected({ body: res.body.result }, "path");
  };

  it.each([
    ["starts_with", "starts_with", "/q'", [hostile.quote]],
    ["ends_with", "ends_with", "; drop table events; --", [hostile.quote]],
    ["contains a percent sign", "contains", "%", [hostile.percent]],
    ["contains an underscore", "contains", "_", [hostile.underscore]],
    ["contains a backslash", "contains", "\\", [hostile.backslash]],
    ["a glob with a literal percent", "matches_glob", "/50%", [hostile.percent]],
    ["a glob with a literal underscore", "matches_glob", "/a_b", [hostile.underscore]],
    ["a glob with a literal backslash", "matches_glob", "/a\\b", [hostile.backslash]],
  ])(
    "%s is matched literally and only against the caller's events",
    async (_l, op, value, want) => {
      const before = await eventCounts();
      expect(await previewRows({ all: [{ field: "data.path", op, value }] })).toEqual(
        [...want].sort(),
      );
      expect(await eventCounts()).toEqual(before);
    },
  );

  it.each([
    "' or '1'='1",
    "' or 1=1 --",
    "'); select pg_sleep(30); --",
    "$$ or true $$",
    "\\' or \\'1\\'=\\'1",
  ])("the classic always-true value %j matches nothing", async (value) => {
    const started = Date.now();
    for (const op of ["starts_with", "ends_with", "contains", "matches_glob"]) {
      expect(await previewRows({ all: [{ field: "data.path", op, value }] }), op).toEqual([]);
    }
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("the same value through a saved endpoint is just as literal", async () => {
    const created = await create(h.a, "hostile", {
      ...paths,
      when: { all: [{ field: "data.path", op: "starts_with", value: "/q'" }] },
    });
    const res = await me("hostile", created.key);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: "events", rows: [{ path: hostile.quote }], truncated: false });
  });

  it("an any-everything condition still returns only the caller's events", async () => {
    const rows = await previewRows({
      any: [
        { field: "data.path", op: "exists", value: true },
        { field: "data.path", op: "exists", value: false },
      ],
    });
    expect(rows).toHaveLength(Object.keys(hostile).length + decoys.length);
    expect(rows).not.toContain(undefined);
  });

  it("a hostile time zone cannot be stored, so it never reaches a query", async () => {
    const res = await http()
      .patch("/v1/settings")
      .set("Cookie", h.a.cookie)
      .send({ timeZone: `UTC'; drop table events; --${TOKEN}` });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    const { rows } = await h.testDb.pool.query('select time_zone from "user" where id = $1', [
      h.a.userId,
    ]);
    expect(rows[0].time_zone).not.toContain(TOKEN);
  });
});

describe("injection through field names and keys", () => {
  const definitions: Array<[string, object]> = [
    [
      "a SQL fragment as a condition field",
      {
        ...paths,
        when: {
          all: [{ field: `data.path'; drop table events; --${TOKEN}`, op: "eq", value: "/" }],
        },
      },
    ],
    [
      "a JSON operator as a condition field",
      {
        ...paths,
        when: { all: [{ field: `data.path' -> 'x${TOKEN}`, op: "exists", value: true }] },
      },
    ],
    [
      "a column name as a condition field",
      { ...paths, when: { all: [{ field: "user_id", op: "exists", value: true }] } },
    ],
    [
      "a SQL fragment as a projected field",
      { ...paths, fields: [`data.path" from events; --${TOKEN}`] },
    ],
    ["another column as a projected field", { ...paths, fields: ["user_id"] }],
    ["the event id as a projected field", { ...paths, fields: ["id"] }],
    ["the integration as a projected field", { ...paths, fields: ["integrationId"] }],
    ["a star as a projected field", { ...paths, fields: ["*"] }],
    [
      "SQL in the aggregate",
      { ...countByDay, aggregate: `count_by_day; drop table events --${TOKEN}` },
    ],
    ["SQL in the window kind", { ...paths, window: { kind: `today'; --${TOKEN}` } }],
    ["a userId key", { ...paths, userId: "someone-else" }],
    ["a raw sql key", { ...paths, sql: `select * from events --${TOKEN}` }],
    ["an offset key", { ...paths, offset: 5 }],
    ["an orderBy key", { ...paths, orderBy: "id" }],
    [
      "a source that is no integration kind",
      { ...paths, when: { source: [`http' or '1'='1${TOKEN}`] } },
    ],
    ["a type that is no event type", { ...paths, when: { type: [`x' or '1'='1${TOKEN}`] } }],
    ["fields and aggregate together", { ...paths, aggregate: "count_by_day" }],
    ["a limit as text", { ...paths, limit: `1000 offset 5 --${TOKEN}` }],
    ["a limit over the cap", { ...paths, limit: 1001 }],
    ["a negative limit", { ...paths, limit: -1 }],
    ["a zero limit", { ...paths, limit: 0 }],
    ["a fractional limit", { ...paths, limit: 10.5 }],
    ["more than 90 days", { ...paths, window: { kind: "last_n_days", days: 91 } }],
  ];

  it.each(definitions)(
    "%s is a 400 on preview and on create, and nothing is stored",
    async (_label, definition) => {
      await seed(h.a, { domain: "a.test", path: "/x" });
      await seed(h.b, { domain: "b.test", path: "/x" });
      const events = await eventCounts();
      const victim = await tenantState(h.testDb.pool, h.b.userId);

      const preview = await post(h.a, "/v1/endpoints/preview", { definition });
      const created = await post(h.a, "/v1/endpoints", { slug: "attack", definition });
      for (const res of [preview, created]) {
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
        expect(res.body.code).toBe("request.invalid");
        expect(JSON.stringify(res.body)).not.toContain(TOKEN);
      }
      expect(await endpointCount()).toBe(0);
      expect(await eventCounts()).toEqual(events);
      expect(await tenantState(h.testDb.pool, h.b.userId)).toEqual(victim);
    },
  );

  it.each([
    ["a string", "select * from events"],
    ["an array", [paths]],
    ["null", null],
  ])("a definition that is %s is a 400", async (_label, definition) => {
    const res = await post(h.a, "/v1/endpoints/preview", { definition });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("request.invalid");
  });

  it("a stored definition tampered with in the database is a 409 and never runs", async () => {
    await seed(h.a, { domain: "secret-a.test", path: "/secret-path" });
    const created = await create(h.a, "stats");
    const tampered: object[] = [
      { ...paths, fields: [`data.path" from events; --${TOKEN}`] },
      { ...countByDay, aggregate: `count_by_day; drop table events --${TOKEN}` },
      // Aggregate-only is not a convention of the writer: a stored definition with both is refused.
      { ...countByDay, fields: ["type", "data.path", "data.domain"] },
      { ...paths, limit: 1_000_000 },
      { ...paths, sql: `select * from events --${TOKEN}` },
      { ...paths, window: { kind: "last_n_days", days: 100_000 } },
    ];
    for (const definition of tampered) {
      await h.testDb.pool.query("update endpoints set definition = $1::jsonb where id = $2", [
        JSON.stringify(definition),
        created.endpoint.id,
      ]);
      const res = await me("stats", created.key);
      expect(res.status, JSON.stringify(definition)).toBe(409);
      expect(res.body.code).toBe("saved_query.definition_invalid");
      expect(JSON.stringify(res.body)).not.toMatch(new RegExp(`${TOKEN}|secret-a|secret-path`));
    }
    expect((await eventCounts())[h.a.userId]).toBe(1);
  });

  it.each([
    "%27%20or%201%3D1--",
    "stats%27--",
    "stats%00",
    "%00",
    "..%2F..%2Fv1%2Fevents",
    "..%2Fkeys",
    "STATS",
    "stats%20",
    "st%2Fats",
    "%24%7Bslug%7D",
    "a".repeat(5_000),
  ])("the slug %j is the same 404 as an unknown one, and the key is not consumed", async (slug) => {
    const created = await create(h.a, "stats");
    const unknown = await me("nope", created.key);
    const res = await me(slug, created.key);
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("endpoint.not_found");
    expect(res.body.detail).toBe(unknown.body.detail);
    expect((await me("stats", created.key)).status).toBe(200);
  });

  it("a slug that is not valid percent-encoding is a client error, never a 500", async () => {
    const created = await create(h.a, "stats");
    const res = await me("%E0%A4%A", created.key);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe("row limit", () => {
  const seedMany = (user: FixtureUser, count: number, distinctDomains = false) =>
    h.testDb.pool.query(
      `insert into events (user_id, integration_id, client_event_id, type, type_version, occurred_at, data)
       select $1, $2, gen_random_uuid()::text, 'browser.page_visited', 1,
              '2026-10-14T07:00:00Z'::timestamptz + n * interval '1 second',
              jsonb_build_object('domain', case when $3 then 'd' || n || '.test' else 'a.test' end, 'path', '/')
       from generate_series(1, $4::int) n`,
      [user.userId, user.integrationId, distinctDomains, count],
    );

  it("an endpoint with the largest limit returns 1,000 rows of 1,100 and says it cut", async () => {
    await seedMany(h.a, 1100);
    await seedMany(h.b, 1100);
    const created = await create(h.a, "many", { ...paths, limit: 1000 });
    const res = await me("many", created.key);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1000);
    expect(res.body.truncated).toBe(true);
    const preview = await post(h.a, "/v1/endpoints/preview", {
      definition: { ...paths, limit: 1000 },
    });
    expect(preview.body.result.rows).toHaveLength(1000);
  });

  it("the default limit is 100 rows", async () => {
    await seedMany(h.a, 150);
    const created = await create(h.a, "many", paths);
    const res = await me("many", created.key);
    expect(res.body.rows).toHaveLength(100);
    expect(res.body.truncated).toBe(true);
  });

  it("an aggregate is limited as well", async () => {
    await seedMany(h.a, 1100, true);
    const created = await create(h.a, "domains", {
      when: { type: ["browser.page_visited"] },
      window: { kind: "last_n_days", days: 7 },
      aggregate: "count_by_domain",
      limit: 1000,
    });
    const res = await me("domains", created.key);
    expect(res.body.rows).toHaveLength(1000);
    expect(res.body.truncated).toBe(true);
  });

  it("a limit in the query string does not widen the stored one", async () => {
    await seedMany(h.a, 20);
    const created = await create(h.a, "few", { ...paths, limit: 5 });
    for (const query of [
      "limit=1000",
      "limit=1000&offset=0",
      "limit[]=1000",
      "definition[limit]=1000",
    ]) {
      const res = await http()
        .get(`/v1/me/few?${query}`)
        .set("Authorization", `Bearer ${created.key}`);
      expect(res.status, query).toBe(200);
      expect(res.body.rows, query).toHaveLength(5);
    }
  });
});

describe("statement timeout", () => {
  /**
   * Holds an ACCESS EXCLUSIVE lock on `events` from another connection, so the saved query waits
   * for it and only the 2-second `statement_timeout` ends it: a real timeout, with no fake slow SQL.
   */
  async function withEventsLocked<T>(fn: () => Promise<T>): Promise<T> {
    const client = await h.testDb.pool.connect();
    try {
      await client.query("begin");
      await client.query("lock table events in access exclusive mode");
      return await fn();
    } finally {
      await client.query("rollback");
      client.release();
    }
  }

  it("a query that cannot finish in 2 seconds is a 504 saved_query.timeout, for a key and a preview", async () => {
    await seed(h.a, { domain: "a.test", path: "/x" });
    const created = await create(h.a, "stats");

    const [viaKey, viaPreview, elapsed] = await withEventsLocked(async () => {
      const started = Date.now();
      const key = await me("stats", created.key);
      const preview = await post(h.a, "/v1/endpoints/preview", { definition: countByDay });
      return [key, preview, Date.now() - started] as const;
    });

    for (const res of [viaKey, viaPreview]) {
      expect(res.status, JSON.stringify(res.body)).toBe(504);
      expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe("saved_query.timeout");
      expect(JSON.stringify(res.body)).not.toMatch(/a\.test|\/x|events/);
    }
    // Two waits of 2 seconds each: cut by the timeout, not instantly and not minutes later.
    expect(elapsed).toBeGreaterThanOrEqual(3_500);
    expect(elapsed).toBeLessThan(15_000);

    // The cancelled statement leaves nothing behind: the same call works once the lock is gone.
    const after = await me("stats", created.key);
    expect(after.status).toBe(200);
    expect(after.body.rows).toEqual([{ date: "2026-10-14", count: 1 }]);
  }, 30_000);
});

describe("scope escalation with an endpoint key", () => {
  it("the scope is bound to the endpoint's id, not to its slug", async () => {
    const one = await create(h.a, "one");
    const two = await create(h.a, "two");
    const rename = (id: string, slug: string) =>
      put(h.a, `/v1/endpoints/${id}`, { slug, definition: countByDay });
    // Swap the slugs: "one" now names the endpoint that key `two` is scoped to, and the reverse.
    expect((await rename(one.endpoint.id, "tmp")).status).toBe(200);
    expect((await rename(two.endpoint.id, "one")).status).toBe(200);
    expect((await rename(one.endpoint.id, "two")).status).toBe(200);

    const stale = await me("one", one.key);
    expect(stale.status).toBe(403);
    expect(stale.body.code).toBe("auth.insufficient_scope");
    expect((await me("two", one.key)).status).toBe(200);
    expect((await me("one", two.key)).status).toBe(200);
  });

  it("a key is read from the Authorization header only", async () => {
    const created = await create(h.a, "stats");
    const attempts = [
      () => http().get(`/v1/me/stats?key=${created.key}`),
      () => http().get(`/v1/me/stats?access_token=${created.key}`),
      () => http().get("/v1/me/stats").set("X-Api-Key", created.key),
      () => http().get("/v1/me/stats").set("Cookie", `Authorization=Bearer ${created.key}`),
      () => http().get("/v1/me/stats").set("Authorization", `Basic ${created.key}`),
      () => http().get("/v1/me/stats").set("Authorization", `Bearer ${created.key}x`),
      () =>
        http()
          .get("/v1/me/stats")
          .set("Authorization", `Bearer ${created.key.slice(0, -1)}`),
    ];
    for (const attempt of attempts) {
      const res = await attempt();
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("auth.invalid_key");
    }
  });

  it("query-string and header attempts to name another user or definition change nothing", async () => {
    await seed(h.a, { domain: "a.test", path: "/a" });
    await seed(h.b, { domain: "b.test", path: "/b" });
    await seed(h.b, { domain: "b.test", path: "/b2" });
    const created = await create(h.a, "stats");
    const plain = await me("stats", created.key);
    expect(plain.body.rows).toEqual([{ date: "2026-10-14", count: 1 }]);

    const res = await http()
      .get("/v1/me/stats")
      .query({
        userId: h.b.userId,
        integrationId: h.b.integrationId,
        fields: "type",
        aggregate: "count_by_domain",
        window: "this_week",
        "when[source][]": "http",
      })
      .set("X-User-Id", h.b.userId)
      .set("Authorization", `Bearer ${created.key}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(plain.body);
  });

  it("an endpoint key cannot manage anything or preview a definition", async () => {
    const created = await create(h.a, "stats");
    const bearer = { Authorization: `Bearer ${created.key}` };
    const id = created.endpoint.id;
    const attempts = [
      () => http().post("/v1/endpoints/preview").set(bearer).send({ definition: countByDay }),
      () => http().post("/v1/endpoints").set(bearer).send({ slug: "x", definition: countByDay }),
      () =>
        http().put(`/v1/endpoints/${id}`).set(bearer).send({ slug: "x", definition: countByDay }),
      () => http().delete(`/v1/endpoints/${id}`).set(bearer),
      () => http().post(`/v1/endpoints/${id}/rotate-key`).set(bearer),
      () =>
        http()
          .post("/v1/keys")
          .set(bearer)
          .send({ scopes: ["events:read"] }),
      () => http().get("/v1/settings").set(bearer),
      () => http().get("/v1/integrations").set(bearer),
    ];
    for (const attempt of attempts) expect((await attempt()).status).toBe(401);
    expect(await endpointCount()).toBe(1);
    expect((await me("stats", created.key)).status).toBe(200);
  });

  it("a stored key whose scope names another user's endpoint reads nothing of theirs", async () => {
    await seed(h.b, { domain: "b.test", path: "/b" });
    const mine = await create(h.a, "stats");
    const theirs = await create(h.b, "private-b");
    await h.testDb.pool.query("update api_keys set scopes = $1::jsonb where endpoint_id = $2", [
      JSON.stringify([`endpoint:${theirs.endpoint.id}`]),
      mine.endpoint.id,
    ]);
    const own = await me("stats", mine.key);
    expect(own.status).toBe(403);
    expect(own.body.code).toBe("auth.insufficient_scope");
    // The slug resolves among the KEY OWNER's endpoints, so the other user's slug does not exist.
    expect((await me("private-b", mine.key)).status).toBe(404);
  });

  it("a stored key with a scope that does not parse is refused outright", async () => {
    const created = await create(h.a, "stats");
    for (const scopes of [["endpoint:*"], ["endpoint:"], ["*"], ["events:read", "endpoint:../x"]]) {
      await h.testDb.pool.query("update api_keys set scopes = $1::jsonb where endpoint_id = $2", [
        JSON.stringify(scopes),
        created.endpoint.id,
      ]);
      expect((await me("stats", created.key)).status, JSON.stringify(scopes)).toBe(401);
    }
  });
});

describe("cross-tenant", () => {
  it("another user's endpoint, by a slug only they use, is the same 404 as an unknown one", async () => {
    const attacker = await create(h.a, "mine");
    const victim = await create(h.b, "private-b");
    const unknown = await me("nope", attacker.key);
    const probe = await me("private-b", attacker.key);
    expect(probe.status).toBe(404);
    expect(probe.body.code).toBe("endpoint.not_found");
    expect({ ...probe.body, instance: undefined }).toEqual({
      ...unknown.body,
      instance: undefined,
    });
    expect(JSON.stringify(probe.body)).not.toContain(victim.endpoint.id);
  });

  it("a battery of attacks by one user leaves the other user's data and keys untouched", async () => {
    await seed(h.b, { domain: "b.test", path: "/secret-b" });
    const victimEndpoint = await create(h.b, "private-b");
    const attacker = await create(h.a, "mine");
    const before = await tenantState(h.testDb.pool, h.b.userId);
    const events = await eventCounts();

    const attempts = [
      post(h.a, "/v1/endpoints/preview", {
        definition: {
          ...paths,
          when: { any: [{ field: "data.path", op: "starts_with", value: "/" }] },
        },
      }),
      http().get(`/v1/endpoints/${victimEndpoint.endpoint.id}`).set("Cookie", h.a.cookie),
      put(h.a, `/v1/endpoints/${victimEndpoint.endpoint.id}`, {
        slug: "hijacked",
        definition: countByDay,
      }),
      http().delete(`/v1/endpoints/${victimEndpoint.endpoint.id}`).set("Cookie", h.a.cookie),
      post(h.a, `/v1/endpoints/${victimEndpoint.endpoint.id}/rotate-key`),
      me("private-b", attacker.key),
      me("private-b", victimEndpoint.key.replace(/.$/, "x")),
    ];
    const [preview, ...others] = await Promise.all(attempts);

    for (const res of others) expect(res?.status).toBeGreaterThanOrEqual(400);
    expect(preview?.status).toBe(200);
    expect(preview?.body.result.rows).toEqual([]);
    expect(JSON.stringify([preview, ...others].map((res) => res?.body))).not.toContain("secret-b");
    expect(await tenantState(h.testDb.pool, h.b.userId)).toEqual(before);
    expect(await eventCounts()).toEqual(events);
    expect((await me("private-b", victimEndpoint.key)).status).toBe(200);
  });
});
