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

  it("requires a session", async () => {
    expectProblem(await http().get("/v1/events"), 401, "auth.unauthenticated");
    expectProblem(
      await http().get("/v1/events").set("Authorization", `Bearer ${h.a.ingestKey}`),
      401,
      "auth.unauthenticated",
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

  it("requires a session", async () => {
    const id = await seed(h.a);
    const res = await http()
      .delete("/v1/events")
      .set("Authorization", `Bearer ${h.a.ingestKey}`)
      .send({ ids: [id] });
    expectProblem(res, 401, "auth.unauthenticated");
    expect(ids(await get(h.a, "/v1/events"))).toEqual([id]);
  });
});
