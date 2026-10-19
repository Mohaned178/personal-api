/**
 * M5-04 saved-query compiler and runner against a real database (Testcontainers; CI runs these,
 * Docker may be off locally). Fixed clock: NOW (Wednesday 2026-10-14T12:00Z). Events are seeded
 * with SQL so `occurred_at` and the data are exact.
 */
import { randomUUID } from "node:crypto";
import {
  FOCUS_SEGMENT_MAX_MS,
  SAVED_QUERY_AGGREGATES,
  savedQueryResultSchema,
} from "@personal-api/contracts";
import { compileRuleSet, evaluate } from "@personal-api/rules";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { type CompiledSavedQuery, compileSavedQuery } from "./saved-query.compiler";
import { SavedQueryRepository } from "./saved-query.repository";

const NOW = new Date("2026-10-14T12:00:00.000Z");

let testDb: TestDatabase;
let repo: SavedQueryRepository;

interface Tenant {
  userId: string;
  ext: string;
  http: string;
}
let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  testDb = await startTestDatabase();
  repo = new SavedQueryRepository(testDb.db);
}, 240_000);

afterAll(async () => {
  await testDb?.stop();
});

async function seedTenant(label: string): Promise<Tenant> {
  const userId = `sq-${label}-${randomUUID().slice(0, 8)}`;
  await testDb.pool.query(`insert into "user" (id, name, email) values ($1, $1, $2)`, [
    userId,
    `${userId}@example.test`,
  ]);
  const integration = async (kind: string) =>
    (
      await testDb.pool.query<{ id: string }>(
        `insert into integrations (user_id, kind, name) values ($1, $2, $2) returning id`,
        [userId, kind],
      )
    ).rows[0]?.id as string;
  return { userId, ext: await integration("browser-extension"), http: await integration("http") };
}

beforeEach(async () => {
  await testDb.pool.query(`delete from events`);
  await testDb.pool.query(`delete from integrations`);
  await testDb.pool.query(`delete from "user" where id like 'sq-%'`);
  a = await seedTenant("a");
  b = await seedTenant("b");
});

async function seed(
  tenant: Tenant,
  options: {
    at: string;
    type?: string;
    data?: Record<string, unknown>;
    via?: "ext" | "http";
  },
): Promise<void> {
  const type = options.type ?? "browser.page_visited";
  await testDb.pool.query(
    `insert into events (user_id, integration_id, client_event_id, type, type_version, occurred_at, data)
     values ($1, $2, $3, $4, 1, $5, $6::jsonb)`,
    [
      tenant.userId,
      tenant[options.via ?? "ext"],
      randomUUID(),
      type,
      options.at,
      JSON.stringify(options.data ?? { domain: "example.com", path: "/" }),
    ],
  );
}

const run = (
  tenant: Tenant,
  definition: unknown,
  timeZone = "UTC",
  options?: { timeoutMs?: number },
) =>
  repo.run(
    tenant.userId,
    compileSavedQuery(definition, { userId: tenant.userId, now: NOW, timeZone }),
    options,
  );

const times = async (tenant: Tenant, definition: unknown, timeZone = "UTC") => {
  const result = await run(tenant, definition, timeZone);
  if (result.kind !== "events") throw new Error("expected an events result");
  return result.rows.map((row) => row.occurredAt).sort();
};

const eventsIn = (window: unknown, when: unknown = {}) => ({
  when,
  window,
  fields: ["occurredAt"],
  limit: 1000,
});

describe("windows (cut in the user's time zone, from a bound now)", () => {
  it("today: local midnight to the next", async () => {
    for (const at of [
      "2026-10-13T23:59:59Z",
      "2026-10-14T00:00:00Z",
      "2026-10-14T23:59:59Z",
      "2026-10-15T00:00:00Z",
    ]) {
      await seed(a, { at });
    }
    expect(await times(a, eventsIn({ kind: "today" }))).toEqual([
      "2026-10-14T00:00:00.000Z",
      "2026-10-14T23:59:59.000Z",
    ]);
  });

  it("today in another zone moves with it", async () => {
    for (const at of [
      "2026-10-13T14:59:59Z",
      "2026-10-13T15:00:00Z",
      "2026-10-14T14:59:59Z",
      "2026-10-14T15:00:00Z",
    ]) {
      await seed(a, { at });
    }
    expect(await times(a, eventsIn({ kind: "today" }), "Asia/Tokyo")).toEqual([
      "2026-10-13T15:00:00.000Z",
      "2026-10-14T14:59:59.000Z",
    ]);
  });

  it("this_week: Monday 00:00 to the next Monday", async () => {
    for (const at of [
      "2026-10-11T23:59:59Z",
      "2026-10-12T00:00:00Z",
      "2026-10-18T23:59:59Z",
      "2026-10-19T00:00:00Z",
    ]) {
      await seed(a, { at });
    }
    expect(await times(a, eventsIn({ kind: "this_week" }))).toEqual([
      "2026-10-12T00:00:00.000Z",
      "2026-10-18T23:59:59.000Z",
    ]);
  });

  it("last_n_days: n calendar days ending at the end of today", async () => {
    for (const at of [
      "2026-10-11T23:59:59Z",
      "2026-10-12T00:00:00Z",
      "2026-10-14T23:59:59Z",
      "2026-10-15T00:00:00Z",
    ]) {
      await seed(a, { at });
    }
    expect(await times(a, eventsIn({ kind: "last_n_days", days: 3 }))).toEqual([
      "2026-10-12T00:00:00.000Z",
      "2026-10-14T23:59:59.000Z",
    ]);
    expect(await times(a, eventsIn({ kind: "last_n_days", days: 1 }))).toEqual([
      "2026-10-14T23:59:59.000Z",
    ]);
  });

  it("follows daylight saving: the day Berlin turns the clocks back lasts 25 hours", async () => {
    const dstNow = new Date("2026-10-25T12:00:00.000Z");
    for (const at of [
      "2026-10-24T21:59:59Z",
      "2026-10-24T22:00:00Z",
      "2026-10-25T22:59:59Z",
      "2026-10-25T23:00:00Z",
    ]) {
      await seed(a, { at });
    }
    const query = compileSavedQuery(eventsIn({ kind: "today" }), {
      userId: a.userId,
      now: dstNow,
      timeZone: "Europe/Berlin",
    });
    const result = await repo.run(a.userId, query);
    if (result.kind !== "events") throw new Error("expected events");
    expect(result.rows.map((r) => r.occurredAt).sort()).toEqual([
      "2026-10-24T22:00:00.000Z",
      "2026-10-25T22:59:59.000Z",
    ]);
  });
});

/** Valid events (parseEvent-valid) with a unique `occurredAt` each, to compare SQL with the engine. */
interface Fixture {
  type: string;
  data: Record<string, unknown>;
  via: "ext" | "http";
}
const TAB_REF = "k3j2h1g4f5d6a7b8";
const visited = (domain: string, path: string, extra: Record<string, unknown> = {}): Fixture => ({
  type: "browser.page_visited",
  data: { domain, path, tabRef: TAB_REF, ...extra },
  via: "ext",
});
const segment = (
  domain: string,
  path: string,
  durationMs: number,
  startedAt = "2026-10-14T09:00:00.000Z",
): Fixture => ({
  type: "browser.focus_segment",
  data: {
    domain,
    path,
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(),
    durationMs,
  },
  via: "ext",
});
const FIXTURES: Fixture[] = [
  visited("github.com", "/Mohaned178/IdentiK", { transition: "link" }),
  visited("github.com", "/settings/profile", { transition: "typed" }),
  visited("gist.github.com", "/a"),
  visited("example.com", "/100%_done/a\\b"),
  visited("example.com", "/100x_done"),
  visited("example.org", "/%"),
  visited("notgithub.com", "/"),
  { ...visited("example.com", "/from-http"), via: "http" },
  segment("github.com", "/Mohaned178/IdentiK", 300_000),
  segment("example.com", "/", 5_000, "2026-10-14T08:00:00.000Z"),
  { type: "browser.tab_opened", data: { tabRef: TAB_REF, domain: "github.com" }, via: "ext" },
  { type: "browser.tab_opened", data: { tabRef: TAB_REF }, via: "ext" },
  { type: "browser.tab_closed", data: { tabRef: TAB_REF }, via: "ext" },
  { type: "browser.session_started", data: { reason: "startup" }, via: "ext" },
  { type: "browser.session_ended", data: { reason: "idle" }, via: "http" },
];

const cond = (field: string, op: string, value: unknown) => ({ field, op, value });

/** One `when` per interesting op and missing-field case (docs/rule-format.md). */
const WHENS: Array<[string, unknown]> = [
  ["everything", {}],
  ["source ext", { source: ["browser-extension"] }],
  ["source http", { source: ["http"] }],
  ["type glob", { type: ["browser.page_*"] }],
  ["eq", { all: [cond("data.domain", "eq", "github.com")] }],
  ["neq", { all: [cond("data.domain", "neq", "github.com")] }],
  ["in", { all: [cond("data.domain", "in", ["github.com", "example.org"])] }],
  ["starts_with", { all: [cond("data.path", "starts_with", "/settings")] }],
  ["ends_with", { all: [cond("data.path", "ends_with", "IdentiK")] }],
  ["contains percent", { all: [cond("data.path", "contains", "%")] }],
  ["contains underscore", { all: [cond("data.path", "contains", "_")] }],
  ["contains backslash", { all: [cond("data.path", "contains", "\\")] }],
  ["domain exact", { all: [cond("data.domain", "domain_matches", "github.com")] }],
  ["domain wildcard", { all: [cond("data.domain", "domain_matches", "*.github.com")] }],
  ["glob percent literal", { all: [cond("data.path", "matches_glob", "/100%*")] }],
  ["glob underscore literal", { all: [cond("data.path", "matches_glob", "/100_*")] }],
  ["glob backslash literal", { all: [cond("data.path", "matches_glob", "*a\\b")] }],
  ["glob star", { all: [cond("data.path", "matches_glob", "/*/*")] }],
  ["gt int", { all: [cond("data.durationMs", "gt", 5_000)] }],
  ["lt int", { all: [cond("data.durationMs", "lt", 300_000)] }],
  ["gt timestamp", { all: [cond("data.endedAt", "gt", "2026-10-14T09:00:00Z")] }],
  ["lt timestamp", { all: [cond("data.startedAt", "lt", "2026-10-14T09:00:00Z")] }],
  ["exists", { all: [cond("data.domain", "exists", true)] }],
  ["not exists", { all: [cond("data.domain", "exists", false)] }],
  ["enum eq", { all: [cond("data.transition", "eq", "link")] }],
  ["none (missing satisfies)", { none: [cond("data.domain", "eq", "github.com")] }],
  ["none with neq", { none: [cond("data.domain", "neq", "github.com")] }],
  ["none path prefix", { none: [cond("data.path", "starts_with", "/settings")] }],
  [
    "all + none",
    {
      type: ["browser.*"],
      all: [cond("data.domain", "domain_matches", "github.com")],
      none: [cond("data.path", "starts_with", "/settings")],
    },
  ],
  [
    "any",
    {
      any: [
        cond("data.domain", "eq", "example.org"),
        cond("data.path", "starts_with", "/settings"),
      ],
    },
  ],
  [
    "any + none",
    {
      any: [cond("data.domain", "eq", "example.com"), cond("data.reason", "eq", "idle")],
      none: [cond("data.path", "contains", "http")],
    },
  ],
];

describe("parity with the rule engine", () => {
  it("selects exactly the events the engine matches, for every op and missing-field case", async () => {
    const at = (i: number) => new Date(Date.UTC(2026, 9, 14, 6, i)).toISOString();
    for (const [i, f] of FIXTURES.entries()) {
      await seed(a, { at: at(i), type: f.type, data: f.data, via: f.via });
    }

    for (const [name, when] of WHENS) {
      const rule = {
        id: "0192f1c2-7c1e-7a3b-9f00-000000000001",
        name: "match",
        enabled: true,
        priority: 1,
        stage: "collect",
        when,
        // biome-ignore lint/suspicious/noThenProperty: `then` is the rule format's own key.
        then: [{ action: "allow" }],
      };
      const compiled = compileRuleSet({ version: 1, rules: [rule as never] });
      if (!compiled.ok) throw new Error(`fixture rule ${name} does not compile`);
      const expected = FIXTURES.flatMap((f, i) => {
        const result = evaluate(
          {
            id: "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b",
            type: f.type,
            typeVersion: 1,
            occurredAt: at(i),
            data: f.data,
          },
          compiled.ruleSet,
          "deny",
          { source: f.via === "ext" ? "browser-extension" : "http", process: false },
        );
        if (result.decision === "error") throw new Error(`fixture ${i} is not a valid event`);
        return result.decision === "allow" ? [at(i)] : [];
      });

      const got = await times(a, eventsIn({ kind: "today" }, when));
      expect(got, name).toEqual(expected.sort());
    }
  });
});

describe("projection", () => {
  it("returns exactly the requested keys, newest first, and null where the type lacks the field", async () => {
    await seed(a, {
      at: "2026-10-14T08:00:00Z",
      data: { domain: "a.test", path: "/p", tabRef: TAB_REF, transition: "link" },
    });
    await seed(a, {
      at: "2026-10-14T09:00:00Z",
      type: "browser.tab_opened",
      data: { tabRef: TAB_REF },
    });
    const result = await run(a, {
      when: {},
      window: { kind: "today" },
      fields: ["type", "occurredAt", "data.domain", "data.path"],
    });
    expect(savedQueryResultSchema.parse(result)).toEqual(result);
    expect(result).toEqual({
      kind: "events",
      truncated: false,
      rows: [
        {
          type: "browser.tab_opened",
          occurredAt: "2026-10-14T09:00:00.000Z",
          domain: null,
          path: null,
        },
        {
          type: "browser.page_visited",
          occurredAt: "2026-10-14T08:00:00.000Z",
          domain: "a.test",
          path: "/p",
        },
      ],
    });
  });

  it("returns numbers as numbers and never leaks fields that were not asked for", async () => {
    const f = segment("a.test", "/p", 4_000);
    await seed(a, {
      at: "2026-10-14T08:00:00Z",
      type: f.type,
      data: { ...f.data, tabRef: TAB_REF },
    });
    const result = await run(a, {
      when: {},
      window: { kind: "today" },
      fields: ["data.durationMs"],
    });
    expect(result).toEqual({ kind: "events", truncated: false, rows: [{ durationMs: 4_000 }] });
  });
});

describe("aggregates return only their fixed keys, never raw events", () => {
  beforeEach(async () => {
    await seed(a, { at: "2026-10-13T08:00:00Z", data: { domain: "a.test", path: "/secret" } });
    await seed(a, { at: "2026-10-14T08:00:00Z", data: { domain: "a.test", path: "/more" } });
    await seed(a, { at: "2026-10-14T09:00:00Z", data: { domain: "b.test", path: "/x" } });
    await seed(a, {
      at: "2026-10-14T09:30:00Z",
      type: "browser.tab_opened",
      data: { tabRef: TAB_REF },
    });
    const f = segment("a.test", "/secret", 60_000);
    await seed(a, { at: "2026-10-14T10:00:00Z", type: f.type, data: f.data });
    const g = segment("b.test", "/x", 999_999_999);
    await seed(a, { at: "2026-10-14T11:00:00Z", type: g.type, data: g.data });
  });

  const window = { kind: "last_n_days", days: 7 };

  it("count_by_day cuts days in the user's time zone", async () => {
    expect(await run(a, { when: {}, window, aggregate: "count_by_day" })).toEqual({
      kind: "count_by_day",
      truncated: false,
      rows: [
        { date: "2026-10-13", count: 1 },
        { date: "2026-10-14", count: 5 },
      ],
    });
    const tokyo = await run(a, { when: {}, window, aggregate: "count_by_day" }, "Asia/Tokyo");
    expect(tokyo.rows).toEqual([
      { date: "2026-10-13", count: 1 },
      { date: "2026-10-14", count: 5 },
    ]);
  });

  it("count_by_domain skips events without a domain and sorts by count then name", async () => {
    expect(await run(a, { when: {}, window, aggregate: "count_by_domain" })).toEqual({
      kind: "count_by_domain",
      truncated: false,
      rows: [
        { domain: "a.test", count: 3 },
        { domain: "b.test", count: 2 },
      ],
    });
  });

  it("duration_by_domain sums only focus segments, each clamped to 30 minutes", async () => {
    expect(
      await run(a, { when: { type: ["browser.*"] }, window, aggregate: "duration_by_domain" }),
    ).toEqual({
      kind: "duration_by_domain",
      truncated: false,
      rows: [
        { domain: "b.test", activeMs: FOCUS_SEGMENT_MAX_MS },
        { domain: "a.test", activeMs: 60_000 },
      ],
    });
  });

  it("has an exact set of keys per aggregate, and never an event field", async () => {
    const keys: Record<string, string[]> = {
      count_by_day: ["count", "date"],
      count_by_domain: ["count", "domain"],
      duration_by_domain: ["activeMs", "domain"],
    };
    for (const aggregate of SAVED_QUERY_AGGREGATES) {
      const result = await run(a, { when: { type: ["browser.*"] }, window, aggregate });
      expect(savedQueryResultSchema.parse(result)).toEqual(result);
      expect(result.rows.length).toBeGreaterThan(0);
      for (const row of result.rows) expect(Object.keys(row).sort()).toEqual(keys[aggregate]);
      expect(JSON.stringify(result)).not.toMatch(/secret|more|"x"|path|tabRef|id"/);
    }
  });

  it("applies the same filters as a raw query", async () => {
    const result = await run(a, {
      when: { type: ["browser.page_visited"], all: [cond("data.path", "starts_with", "/secret")] },
      window,
      aggregate: "count_by_domain",
    });
    expect(result.rows).toEqual([{ domain: "a.test", count: 1 }]);
  });
});

describe("row limit", () => {
  beforeEach(async () => {
    for (let i = 0; i < 5; i++) await seed(a, { at: `2026-10-14T0${i}:00:00Z` });
  });

  it("returns at most `limit` rows and says when it cut", async () => {
    const result = await run(a, { ...eventsIn({ kind: "today" }), limit: 3 });
    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(await run(a, { ...eventsIn({ kind: "today" }), limit: 5 })).toMatchObject({
      truncated: false,
    });
  });

  it("returns the newest rows when it cuts raw events", async () => {
    const result = await run(a, { ...eventsIn({ kind: "today" }), limit: 2 });
    expect(result.rows).toEqual([
      { occurredAt: "2026-10-14T04:00:00.000Z" },
      { occurredAt: "2026-10-14T03:00:00.000Z" },
    ]);
  });

  it("limits an aggregate too", async () => {
    for (const d of ["a", "b", "c", "d"]) {
      await seed(a, { at: "2026-10-14T06:00:00Z", data: { domain: `${d}.test`, path: "/" } });
    }
    const result = await run(a, {
      when: {},
      window: { kind: "today" },
      aggregate: "count_by_domain",
      limit: 2,
    });
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("caps a hand-built query at 1,000 rows whatever its limit says", async () => {
    await testDb.pool.query(
      `insert into events (user_id, integration_id, client_event_id, type, type_version, occurred_at, data)
       select $1, $2, gen_random_uuid()::text, 'browser.page_visited', 1,
              '2026-10-14T07:00:00Z'::timestamptz + n * interval '1 second', '{"domain":"a.test","path":"/"}'::jsonb
       from generate_series(1, 1100) n`,
      [a.userId, a.ext],
    );
    const query = {
      ...compileSavedQuery(eventsIn({ kind: "today" }), {
        userId: a.userId,
        now: NOW,
        timeZone: "UTC",
      }),
      limit: 1_000_000,
    } as CompiledSavedQuery;
    const result = await repo.run(a.userId, query);
    expect(result.rows).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });
});

describe("statement timeout and read-only", () => {
  const probe = (where: ReturnType<typeof sql>): CompiledSavedQuery => ({
    kind: "events",
    where,
    fields: ["type"],
    limit: 10,
  });

  it("cancels a slow query with a pg query_canceled error", async () => {
    await seed(a, { at: "2026-10-14T08:00:00Z" });
    const error = await repo
      .run(a.userId, probe(sql`pg_sleep(2) is not null`), { timeoutMs: 50 })
      .catch((e: unknown) => e);
    const code =
      (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    expect(code).toBe("57014");
  });

  it("applies 2 seconds by default, and read-only, inside the query's own transaction", async () => {
    await seed(a, { at: "2026-10-14T08:00:00Z" });
    const timeout = await repo.run(
      a.userId,
      probe(sql`current_setting('statement_timeout') = '2s'`),
    );
    expect(timeout.rows).toHaveLength(1);
    const readOnly = await repo.run(
      a.userId,
      probe(sql`current_setting('transaction_read_only') = 'on'`),
    );
    expect(readOnly.rows).toHaveLength(1);
  });

  it("does not leak the timeout to the next query on the pool", async () => {
    await seed(a, { at: "2026-10-14T08:00:00Z" });
    await repo.run(a.userId, probe(sql`true`), { timeoutMs: 50 });
    for (let i = 0; i < 5; i++) {
      const { rows } = await testDb.pool.query<{ statement_timeout: string }>(
        `show statement_timeout`,
      );
      expect(rows[0]?.statement_timeout).toBe("0");
    }
  });
});

describe("tenant scoping", () => {
  beforeEach(async () => {
    await seed(a, { at: "2026-10-14T08:00:00Z", data: { domain: "a.test", path: "/a" } });
    await seed(b, { at: "2026-10-14T08:30:00Z", data: { domain: "b.test", path: "/b" } });
    await seed(b, {
      at: "2026-10-14T08:45:00Z",
      data: { domain: "b.test", path: "/b2" },
      via: "http",
    });
  });

  it("returns only the caller's events, whatever the filters", async () => {
    const result = await run(a, {
      when: {},
      window: { kind: "today" },
      fields: ["data.domain", "data.path"],
    });
    expect(result.rows).toEqual([{ domain: "a.test", path: "/a" }]);
    const orEverything = await run(a, {
      when: { any: [cond("data.domain", "exists", true), cond("data.domain", "exists", false)] },
      window: { kind: "today" },
      fields: ["data.domain"],
    });
    expect(orEverything.rows).toEqual([{ domain: "a.test" }]);
  });

  it("aggregates only the caller's events", async () => {
    expect(
      await run(a, { when: {}, window: { kind: "today" }, aggregate: "count_by_domain" }),
    ).toMatchObject({ rows: [{ domain: "a.test", count: 1 }] });
  });

  it("matches `source` against the caller's integrations only", async () => {
    // Only user B has an http event, so A's http-only query is empty.
    const result = await run(a, { ...eventsIn({ kind: "today" }, { source: ["http"] }) });
    expect(result.rows).toEqual([]);
    const own = await run(b, { ...eventsIn({ kind: "today" }, { source: ["http"] }) });
    expect(own.rows).toEqual([{ occurredAt: "2026-10-14T08:45:00.000Z" }]);
  });
});
