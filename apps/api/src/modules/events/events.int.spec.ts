/**
 * M3-04 session events API: filters, keyset paging, get one, delete by ids, and the cross-tenant
 * behavior of each. Real application against Testcontainers (CI runs these; Docker may be off
 * locally), two-user fixture. Events are seeded with SQL so `occurred_at` is exact.
 */
import { randomUUID } from "node:crypto";
import {
  deleteEventsResponseSchema,
  getEventResponseSchema,
  listEventsResponseSchema,
} from "@personal-api/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FIXED_NOW,
  type IngestHarness,
  PROBLEM_JSON,
  startIngestHarness,
} from "../../../test/ingest-helpers";
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

const http = () => request(h.app.getHttpServer());
const get = (u: FixtureUser, path: string) => http().get(path).set("Cookie", u.cookie);
const del = (u: FixtureUser, body: unknown) =>
  http()
    .delete("/v1/events")
    .set("Cookie", u.cookie)
    .send(body as object);

const T0 = Date.parse(FIXED_NOW);
const at = (minutesAgo: number) => new Date(T0 - minutesAgo * 60_000).toISOString();

async function seed(
  user: FixtureUser,
  options: { minutesAgo?: number; type?: string; domain?: string; occurredAt?: string } = {},
): Promise<string> {
  const { rows } = await h.testDb.pool.query<{ id: string }>(
    `insert into events (user_id, integration_id, client_event_id, type, type_version, occurred_at, data)
     values ($1, $2, $3, $4, 1, $5, $6::jsonb) returning id`,
    [
      user.userId,
      user.integrationId,
      randomUUID(),
      options.type ?? "browser.page_visited",
      options.occurredAt ?? at(options.minutesAgo ?? 0),
      JSON.stringify({ domain: options.domain ?? "example.com", path: "/" }),
    ],
  );
  return (rows[0] as { id: string }).id;
}

const ids = (res: { body: unknown }) =>
  listEventsResponseSchema.parse(res.body).events.map((e) => e.id);

function expectProblem(
  res: { status: number; headers: Record<string, unknown>; body: { code?: string } },
  status: number,
  code: string,
) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(String(res.headers["content-type"])).toMatch(PROBLEM_JSON);
  expect(res.body.code).toBe(code);
}

describe("GET /v1/events", () => {
  it("lists the caller's events newest first, and never another user's", async () => {
    const old = await seed(h.a, { minutesAgo: 10 });
    const recent = await seed(h.a, { minutesAgo: 1 });
    const theirs = await seed(h.b, { minutesAgo: 5 });
    const res = await get(h.a, "/v1/events");
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([recent, old]);
    expect(JSON.stringify(res.body)).not.toContain(theirs);
    expect(listEventsResponseSchema.parse(res.body).nextCursor).toBeNull();
  });

  it("pages with a keyset cursor, with no gaps or repeats, including equal timestamps", async () => {
    const same = at(3);
    const all = [
      await seed(h.a, { minutesAgo: 9 }),
      await seed(h.a, { occurredAt: same }),
      await seed(h.a, { occurredAt: same }),
      await seed(h.a, { occurredAt: same }),
      await seed(h.a, { minutesAgo: 1 }),
    ];
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const query: string = `limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const res = await get(h.a, `/v1/events?${query}`);
      expect(res.status).toBe(200);
      const body = listEventsResponseSchema.parse(res.body);
      seen.push(...body.events.map((e) => e.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(all));
  });

  it("filters by source, type, domain and time range (from inclusive, to exclusive)", async () => {
    const other = await seed(h.a, { minutesAgo: 20, type: "browser.focus_segment" });
    const github = await seed(h.a, { minutesAgo: 10, domain: "github.com" });
    const edge = await seed(h.a, { minutesAgo: 5 });
    expect(ids(await get(h.a, "/v1/events?type=browser.focus_segment"))).toEqual([other]);
    expect(ids(await get(h.a, "/v1/events?domain=github.com"))).toEqual([github]);
    expect(ids(await get(h.a, `/v1/events?source=${h.a.integrationId}`))).toHaveLength(3);
    expect(ids(await get(h.a, `/v1/events?source=${randomUUID()}`))).toEqual([]);
    expect(ids(await get(h.a, `/v1/events?from=${at(10)}&to=${at(5)}`))).toEqual([github]);
    expect(ids(await get(h.a, `/v1/events?from=${at(5)}`))).toEqual([edge]);
  });

  it("treats a filter value as data, never as SQL", async () => {
    await seed(h.a);
    const res = await get(h.a, `/v1/events?type=${encodeURIComponent("x' or '1'='1")}`);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([]);
  });

  it.each([
    ["userId in the query", "userId=00000000-0000-0000-0000-000000000000"],
    ["limit 0", "limit=0"],
    ["a bad date", "from=yesterday"],
  ])("refuses %s with request.invalid", async (_label, query) => {
    expectProblem(await get(h.a, `/v1/events?${query}`), 400, "request.invalid");
  });

  it("answers a malformed cursor with events.cursor_invalid", async () => {
    expectProblem(await get(h.a, "/v1/events?cursor=not-a-cursor"), 400, "events.cursor_invalid");
  });

  it("requires a session (a bearer takes the read-key path: auth.invalid_key)", async () => {
    expectProblem(await http().get("/v1/events"), 401, "auth.unauthenticated");
    expectProblem(
      await http().get("/v1/events").set("Authorization", `Bearer ${h.a.ingestKey}`),
      401,
      "auth.invalid_key",
    );
  });

  it("cannot use another user's cursor to read their rows", async () => {
    await seed(h.a, { minutesAgo: 5 });
    const theirs = await seed(h.b, { minutesAgo: 1 });
    await seed(h.b, { minutesAgo: 2 });
    const first = listEventsResponseSchema.parse((await get(h.b, "/v1/events?limit=1")).body);
    const res = await get(h.a, `/v1/events?cursor=${first.nextCursor ?? ""}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(theirs);
  });
});

describe("GET /v1/events/:id", () => {
  it("returns the caller's event", async () => {
    const id = await seed(h.a, { domain: "github.com" });
    const res = await get(h.a, `/v1/events/${id}`);
    expect(res.status).toBe(200);
    const { event } = getEventResponseSchema.parse(res.body);
    expect(event).toMatchObject({
      id,
      integrationId: h.a.integrationId,
      origin: "collected",
      data: { domain: "github.com", path: "/" },
    });
  });

  it("returns the stored trace, and null when there is none or it is unreadable", async () => {
    const ruleId = randomUUID();
    const trace = {
      ruleSetVersion: 2,
      matched: [{ ruleId, actions: ["allow"] }],
      decidedBy: ruleId,
    };
    const traced = await seed(h.a);
    const bare = await seed(h.a);
    const broken = await seed(h.a);
    for (const [id, value] of [
      [traced, trace],
      [broken, { ruleSetVersion: -1, domain: "secret.example" }],
    ] as const) {
      await h.testDb.pool.query("update events set trace = $2::jsonb where id = $1", [
        id,
        JSON.stringify(value),
      ]);
    }
    const read = async (id: string) =>
      getEventResponseSchema.parse((await get(h.a, `/v1/events/${id}`)).body).event.trace;
    expect(await read(traced)).toEqual(trace);
    expect(await read(bare)).toBeNull();
    expect(await read(broken)).toBeNull();
  });

  it("gives a foreign, unknown and malformed id the same 404", async () => {
    const theirs = await seed(h.b);
    const foreign = await get(h.a, `/v1/events/${theirs}`);
    expectProblem(foreign, 404, "event.not_found");
    for (const other of [randomUUID(), "not-a-uuid"]) {
      const res = await get(h.a, `/v1/events/${other}`);
      expect(res.status).toBe(foreign.status);
      expect(res.body).toEqual(foreign.body);
    }
  });
});

describe("DELETE /v1/events", () => {
  it("deletes the caller's events by id and reports the count", async () => {
    const a1 = await seed(h.a);
    const a2 = await seed(h.a);
    const keep = await seed(h.a);
    const res = await del(h.a, { ids: [a1, a2, a1] });
    expect(res.status).toBe(200);
    expect(deleteEventsResponseSchema.parse(res.body)).toEqual({ deleted: 2 });
    expect(ids(await get(h.a, "/v1/events"))).toEqual([keep]);
  });

  it("does not delete another user's events, and does not tell them apart from unknown ids", async () => {
    const theirs = await seed(h.b);
    const mine = await seed(h.a);
    const res = await del(h.a, { ids: [theirs, randomUUID(), mine] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 1 });
    expect(ids(await get(h.b, "/v1/events"))).toEqual([theirs]);
  });

  it.each([
    ["no ids", { ids: [] }],
    ["a malformed id", { ids: ["1 or 1=1"] }],
    ["a filter instead of ids", { type: "browser.page_visited" }],
    ["userId in the body", { ids: [randomUUID()], userId: randomUUID() }],
  ])("refuses %s and deletes nothing", async (_label, body) => {
    await seed(h.a);
    expectProblem(await del(h.a, body), 400, "request.invalid");
    expect(ids(await get(h.a, "/v1/events"))).toHaveLength(1);
  });

  it("requires a session (a bearer takes the read-key path: auth.invalid_key)", async () => {
    const id = await seed(h.a);
    const res = await http()
      .delete("/v1/events")
      .set("Authorization", `Bearer ${h.a.ingestKey}`)
      .send({ ids: [id] });
    expectProblem(res, 401, "auth.unauthenticated");
    expect(ids(await get(h.a, "/v1/events"))).toEqual([id]);
  });
});

describe("GET /v1/events with a read key (M5-02)", () => {
  async function mint(user: FixtureUser, body: object = { scopes: ["events:read"] }) {
    const res = await http().post("/v1/keys").set("Cookie", user.cookie).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.key as string;
  }
  const keyGet = (key: string, path = "/v1/events") =>
    http().get(path).set("Authorization", `Bearer ${key}`);

  it("lists the key owner's events, and only theirs", async () => {
    const mine = await seed(h.a, { minutesAgo: 1 });
    const theirs = await seed(h.b, { minutesAgo: 2 });
    const res = await keyGet(await mint(h.a));
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([mine]);
    expect(JSON.stringify(res.body)).not.toContain(theirs);
    expect(ids(await keyGet(await mint(h.b)))).toEqual([theirs]);
  });

  it("applies the same filters and cursor as a session", async () => {
    const e1 = await seed(h.a, { minutesAgo: 3 });
    const e2 = await seed(h.a, { minutesAgo: 2 });
    const e3 = await seed(h.a, { minutesAgo: 1 });
    const key = await mint(h.a);
    const first = await keyGet(key, "/v1/events?limit=2");
    expect(ids(first)).toEqual([e3, e2]);
    const cursor = listEventsResponseSchema.parse(first.body).nextCursor;
    expect(ids(await keyGet(key, `/v1/events?limit=2&cursor=${cursor}`))).toEqual([e1]);
  });

  it("needs the events:read scope", async () => {
    await seed(h.a);
    const res = await keyGet(await mint(h.a, { scopes: ["activity:read"] }));
    expectProblem(res, 403, "auth.insufficient_scope");
  });

  it("narrows to the key's sources and types, and a filter cannot widen it", async () => {
    const visit = await seed(h.a, { type: "browser.page_visited", minutesAgo: 3 });
    const focus = await seed(h.a, { type: "browser.tab_focus", minutesAgo: 2 });
    await seed(h.a, { type: "device.battery", minutesAgo: 1 });
    const globKey = await mint(h.a, {
      scopes: ["events:read"],
      restriction: { types: ["browser.*"] },
    });
    expect(ids(await keyGet(globKey)).sort()).toEqual([visit, focus].sort());
    expect(ids(await keyGet(globKey, "/v1/events?type=device.battery"))).toEqual([]);

    const exactKey = await mint(h.a, {
      scopes: ["events:read"],
      restriction: { types: ["browser.page_visited"] },
    });
    expect(ids(await keyGet(exactKey))).toEqual([visit]);

    const other = await http()
      .post("/v1/integrations")
      .set("Cookie", h.a.cookie)
      .send({ kind: "http", name: "other" });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    const sourceKey = await mint(h.a, {
      scopes: ["events:read"],
      restriction: { sources: [other.body.integration.id] },
    });
    expect(ids(await keyGet(sourceKey))).toEqual([]);
    const ownSourceKey = await mint(h.a, {
      scopes: ["events:read"],
      restriction: { sources: [h.a.integrationId], types: ["browser.tab_focus"] },
    });
    expect(ids(await keyGet(ownSourceKey))).toEqual([focus]);
  });

  it("treats _ in a type pattern as a literal, not a LIKE wildcard", async () => {
    const literal = await seed(h.a, { type: "app.page_visited", minutesAgo: 2 });
    await seed(h.a, { type: "app.pagexvisited", minutesAgo: 1 });
    const key = await mint(h.a, {
      scopes: ["events:read"],
      restriction: { types: ["app.page_*"] },
    });
    expect(ids(await keyGet(key))).toEqual([literal]);
  });

  it("returns events without the rule trace, which a session still sees", async () => {
    const id = await seed(h.a);
    await h.testDb.pool.query("update events set trace = $2::jsonb where id = $1", [
      id,
      JSON.stringify({
        ruleSetVersion: 3,
        matched: [{ ruleId: randomUUID(), actions: ["allow"] }],
        decidedBy: randomUUID(),
      }),
    ]);
    const viaKey = listEventsResponseSchema.parse((await keyGet(await mint(h.a))).body);
    expect(viaKey.events[0]?.trace).toBeNull();
    const viaSession = listEventsResponseSchema.parse((await get(h.a, "/v1/events")).body);
    expect(viaSession.events[0]?.trace).not.toBeNull();
  });

  it("refuses bad and wrong-kind credentials with auth.invalid_key, and ignores a cookie beside them", async () => {
    await seed(h.a);
    for (const bearer of [h.a.ingestKey, "pa_read_nope", randomUUID()]) {
      const res = await http()
        .get("/v1/events")
        .set("Cookie", h.a.cookie)
        .set("Authorization", `Bearer ${bearer}`);
      expectProblem(res, 401, "auth.invalid_key");
    }
  });

  it("refuses a revoked key", async () => {
    const created = await http()
      .post("/v1/keys")
      .set("Cookie", h.a.cookie)
      .send({ scopes: ["events:read"] });
    await http().post(`/v1/keys/${created.body.readKey.id}/revoke`).set("Cookie", h.a.cookie);
    expectProblem(await keyGet(created.body.key), 401, "auth.invalid_key");
  });

  it("keeps get-one and delete dashboard-only", async () => {
    const id = await seed(h.a);
    const key = await mint(h.a);
    expectProblem(await keyGet(key, `/v1/events/${id}`), 401, "auth.unauthenticated");
    const del = await http()
      .delete("/v1/events")
      .set("Authorization", `Bearer ${key}`)
      .send({ ids: [id] });
    expectProblem(del, 401, "auth.unauthenticated");
    expect(ids(await get(h.a, "/v1/events"))).toEqual([id]);
  });
});
