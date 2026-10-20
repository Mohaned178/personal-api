/**
 * M4-04 rules API over HTTP against the real application (Testcontainers; CI runs these, Docker
 * may be off locally), using the two-user fixture.
 *
 * Covers: CRUD with ids and owners set by the server, the rule-set version moving by one on every
 * change (also under concurrent changes) and never on a refused one, a `rule_history` snapshot
 * per version that still holds deleted rules, validation on save (400 `request.invalid` without
 * echoing input, nothing written), the 100-rule cap, `POST /v1/rules/test` (saved rules, a draft,
 * a replacement, a draft alone, and no side effects), and cross-tenant refusals.
 */
import type { INestApplication } from "@nestjs/common";
import {
  deleteRuleResponseSchema,
  RULES_PER_USER_MAX,
  ruleListResponseSchema,
  ruleResponseSchema,
  testRuleResponseSchema,
} from "@personal-api/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tenantState } from "../../../test/adversarial-helpers";
import { FakeClock } from "../../../test/fake-clock";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { buildFixtureApp, type FixtureUser, seedTwoUsers } from "../../../test/two-user-fixture";
import { RulesRepository } from "./rules.repository";

const PROBLEM_JSON = /^application\/problem\+json/;
const SENTINEL = "sentinel-domain-4d2f.example";
const NOW = "2026-10-14T12:00:00.000Z";
const MISSING = "0192f1c2-7c1e-7a3b-9f00-000000000000";

let testDb: TestDatabase;
let app: INestApplication;
const clock = new FakeClock(NOW);
let a: FixtureUser;
let b: FixtureUser;

beforeAll(async () => {
  testDb = await startTestDatabase();
  app = await buildFixtureApp(testDb, { clock });
}, 240_000);

afterAll(async () => {
  await app?.close();
  await testDb?.stop();
});

beforeEach(async () => {
  ({ a, b } = await seedTwoUsers(app, testDb));
});

const http = () => request(app.getHttpServer());
const as = (user: FixtureUser) => ({
  get: (path: string) => http().get(path).set("Cookie", user.cookie),
  post: (path: string, body?: unknown) =>
    http()
      .post(path)
      .set("Cookie", user.cookie)
      .send(body as object),
  put: (path: string, body?: unknown) =>
    http()
      .put(path)
      .set("Cookie", user.cookie)
      .send(body as object),
  delete: (path: string) => http().delete(path).set("Cookie", user.cookie),
});

function rule(overrides: Record<string, unknown> = {}) {
  return {
    name: "Track GitHub",
    enabled: true,
    priority: 10,
    stage: "collect",
    when: { type: ["browser.*"], all: [{ field: "data.domain", op: "eq", value: "github.com" }] },
    then: [{ action: "allow" }],
    ...overrides,
  };
}

async function create(user: FixtureUser, definition: object = rule()) {
  const res = await as(user).post("/v1/rules", definition);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return ruleResponseSchema.parse(res.body);
}

function pageVisit(domain: string, path = "/docs/intro") {
  return {
    id: "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b",
    type: "browser.page_visited",
    typeVersion: 1,
    occurredAt: "2026-10-14T11:59:00.000Z",
    data: { domain, path, transition: "link", tabRef: "tab-ref-12345678" },
  };
}

const versionRows = async (userId: string) =>
  (
    await testDb.pool.query<{ version: number }>(
      "select version from rule_sets where user_id = $1",
      [userId],
    )
  ).rows;
const historyRows = async (userId: string) =>
  (
    await testDb.pool.query<{ rule_set_version: number; snapshot: Array<{ id: string }> }>(
      "select rule_set_version, snapshot from rule_history where user_id = $1 order by rule_set_version",
      [userId],
    )
  ).rows;

describe("CRUD and versioning", () => {
  it("an empty list is version 0, with no rule_sets row", async () => {
    const res = await as(a).get("/v1/rules");
    expect(res.status).toBe(200);
    expect(ruleListResponseSchema.parse(res.body)).toEqual({ version: 0, rules: [] });
    expect(await versionRows(a.userId)).toEqual([]);
  });

  it("creates a rule with a server-set id and owner, and bumps the version to 1", async () => {
    const created = await create(a);
    expect(created.version).toBe(1);
    expect(created.rule).toMatchObject(rule());
    const { rows } = await testDb.pool.query(
      "select user_id, name, enabled, priority, stage from rules where id = $1",
      [created.rule.id],
    );
    expect(rows).toEqual([
      { user_id: a.userId, name: "Track GitHub", enabled: true, priority: 10, stage: "collect" },
    ]);
  });

  it("lists every rule, disabled ones too, by priority then id, with the current version", async () => {
    const late = await create(a, rule({ name: "late", priority: 50 }));
    const off = await create(a, rule({ name: "off", priority: 5, enabled: false }));
    const early = await create(a, rule({ name: "early", priority: 5 }));
    const list = ruleListResponseSchema.parse((await as(a).get("/v1/rules")).body);
    expect(list.version).toBe(3);
    const tied = [off.rule.id, early.rule.id].sort();
    expect(list.rules.map((r) => r.id)).toEqual([...tied, late.rule.id]);
  });

  it("gets one rule with the version", async () => {
    const { rule: stored } = await create(a);
    const res = await as(a).get(`/v1/rules/${stored.id}`);
    expect(res.status).toBe(200);
    expect(ruleResponseSchema.parse(res.body)).toEqual({ rule: stored, version: 1 });
  });

  it("replaces the whole definition, keeps the id, and bumps the version", async () => {
    const { rule: stored } = await create(a);
    const res = await as(a).put(
      `/v1/rules/${stored.id}`,
      rule({ name: "Renamed", priority: 20, enabled: false }),
    );
    expect(res.status).toBe(200);
    const body = ruleResponseSchema.parse(res.body);
    expect(body.version).toBe(2);
    expect(body.rule).toMatchObject({
      id: stored.id,
      name: "Renamed",
      priority: 20,
      enabled: false,
    });
    const { rows } = await testDb.pool.query(
      "select name, priority, enabled, definition->>'name' as def_name from rules where id = $1",
      [stored.id],
    );
    expect(rows).toEqual([{ name: "Renamed", priority: 20, enabled: false, def_name: "Renamed" }]);
  });

  it("deletes a rule and bumps the version", async () => {
    const { rule: stored } = await create(a);
    const res = await as(a).delete(`/v1/rules/${stored.id}`);
    expect(res.status).toBe(200);
    expect(deleteRuleResponseSchema.parse(res.body)).toEqual({ version: 2 });
    expect((await as(a).get(`/v1/rules/${stored.id}`)).status).toBe(404);
    expect(ruleListResponseSchema.parse((await as(a).get("/v1/rules")).body)).toEqual({
      version: 2,
      rules: [],
    });
  });

  it("keeps a snapshot per version, and an old one still holds a deleted rule", async () => {
    const first = await create(a, rule({ name: "first" }));
    const second = await create(a, rule({ name: "second" }));
    await as(a).put(`/v1/rules/${first.rule.id}`, rule({ name: "first v2" }));
    await as(a).delete(`/v1/rules/${second.rule.id}`);

    const history = await historyRows(a.userId);
    expect(history.map((h) => h.rule_set_version)).toEqual([1, 2, 3, 4]);
    expect(history.map((h) => h.snapshot.length)).toEqual([1, 2, 2, 1]);
    expect(history[1]?.snapshot.map((r) => r.id).sort()).toEqual(
      [first.rule.id, second.rule.id].sort(),
    );
    expect(history[0]?.snapshot).toEqual([first.rule]);
    expect(history[3]?.snapshot.map((r) => r.id)).toEqual([first.rule.id]);
  });

  it("a refused change leaves the version and history alone", async () => {
    await create(a);
    for (const res of [
      await as(a).put(`/v1/rules/${MISSING}`, rule()),
      await as(a).delete(`/v1/rules/${MISSING}`),
      await as(a).put("/v1/rules/not-a-uuid", rule()),
      await as(a).post("/v1/rules", rule({ priority: -1 })),
    ]) {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect(await versionRows(a.userId)).toEqual([{ version: 1 }]);
    expect(await historyRows(a.userId)).toHaveLength(1);
  });

  it("concurrent changes give gapless versions and one snapshot each", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => as(a).post("/v1/rules", rule({ name: `rule ${i}` }))),
    );
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(201));
    const versions = results
      .map((r) => ruleResponseSchema.parse(r.body).version)
      .sort((x, y) => x - y);
    expect(versions).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    const history = await historyRows(a.userId);
    expect(history.map((h) => h.snapshot.length)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
  });

  it(`refuses rule ${RULES_PER_USER_MAX + 1} with 409 rule.limit_reached and no change`, async () => {
    const repository = app.get(RulesRepository);
    for (let i = 0; i < RULES_PER_USER_MAX; i += 1) {
      await repository.create(a.userId, rule({ name: `r${i}` }) as never, new Date(NOW));
    }
    const before = await tenantState(testDb.pool, a.userId);
    const res = await as(a).post("/v1/rules", rule());
    expect(res.status).toBe(409);
    expect(String(res.headers["content-type"])).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("rule.limit_reached");
    expect(await versionRows(a.userId)).toEqual([{ version: RULES_PER_USER_MAX }]);
    expect(await tenantState(testDb.pool, a.userId)).toEqual(before);
    // The other user is not affected by A's count, and A can still edit and delete.
    expect((await as(b).post("/v1/rules", rule())).status).toBe(201);
    const list = ruleListResponseSchema.parse((await as(a).get("/v1/rules")).body);
    expect((await as(a).delete(`/v1/rules/${list.rules[0]?.id}`)).status).toBe(200);
    expect((await as(a).post("/v1/rules", rule())).status).toBe(201);
  });
});

describe("a stored definition", () => {
  it("never overrides the row's id (M4-R nit)", async () => {
    const created = await create(a);
    await testDb.pool.query(
      `update rules set definition = definition || jsonb_build_object('id', $2::text) where id = $1`,
      [created.rule.id, MISSING],
    );
    const list = ruleListResponseSchema.parse((await as(a).get("/v1/rules")).body);
    expect(list.rules.map((r) => r.id)).toEqual([created.rule.id]);
  });
});

describe("validation on save", () => {
  const invalid: Array<[string, unknown]> = [
    ["an unknown key", rule({ extra: 1 })],
    ["a body that names the owner", rule({ userId: "someone-else" })],
    ["a body that names an id", rule({ id: MISSING })],
    ["a missing priority", { ...rule(), priority: undefined }],
    ["a priority out of range", rule({ priority: 1001 })],
    ["the reserved forward action", rule({ then: [{ action: "forward" }] })],
    [
      "the keep_query action, reserved for v1.1",
      rule({ then: [{ action: "allow" }, { action: "keep_query" }] }),
    ],
    ["an action from the wrong stage", rule({ stage: "process" })],
    [
      "an op that does not suit the field",
      rule({ when: { all: [{ field: "data.domain", op: "gt", value: 3 }] } }),
    ],
    ["a type pattern that matches nothing", rule({ when: { type: ["browser.page_visted"] } })],
    ["no actions", rule({ then: [] })],
  ];

  it.each(invalid)(
    "POST rejects %s with 400 request.invalid and writes nothing",
    async (_l, body) => {
      const res = await as(a).post("/v1/rules", body);
      expect(res.status).toBe(400);
      expect(String(res.headers["content-type"])).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe("request.invalid");
      expect(await versionRows(a.userId)).toEqual([]);
      expect((await testDb.pool.query("select 1 from rules")).rowCount).toBe(0);
    },
  );

  it("PUT validates the same way and leaves the stored rule alone", async () => {
    const { rule: stored } = await create(a);
    const res = await as(a).put(`/v1/rules/${stored.id}`, rule({ then: [{ action: "forward" }] }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("request.invalid");
    expect(await versionRows(a.userId)).toEqual([{ version: 1 }]);
    expect(ruleResponseSchema.parse((await as(a).get(`/v1/rules/${stored.id}`)).body).rule).toEqual(
      stored,
    );
  });

  it("never echoes the rule's values in an error", async () => {
    const res = await as(a).post(
      "/v1/rules",
      rule({
        when: { all: [{ field: "data.domain", op: "gt", value: SENTINEL }] },
        sentinelKey: SENTINEL,
      }),
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
  });
});

describe("POST /v1/rules/test", () => {
  const test = (user: FixtureUser, body: object) => as(user).post("/v1/rules/test", body);
  const base = { source: "browser-extension" };

  it("with no rules the default policy decides: deny drops, allow collects", async () => {
    const denied = testRuleResponseSchema.parse(
      (await test(a, { ...base, event: pageVisit("github.com") })).body,
    );
    expect(denied).toMatchObject({ decision: "drop", trace: { decidedBy: "default_policy" } });

    const allowed = testRuleResponseSchema.parse(
      (await test(a, { ...base, defaultPolicy: "allow", event: pageVisit("github.com") })).body,
    );
    expect(allowed).toMatchObject({ decision: "allow", trace: { decidedBy: "default_policy" } });
  });

  it("runs the saved rules and reports the deciding rule and the version", async () => {
    const { rule: stored } = await create(a);
    const res = await test(a, { ...base, event: pageVisit("github.com") });
    expect(res.status).toBe(200);
    expect(testRuleResponseSchema.parse(res.body)).toMatchObject({
      decision: "allow",
      trace: { ruleSetVersion: 1, decidedBy: stored.id },
    });
    expect(
      testRuleResponseSchema.parse(
        (await test(a, { ...base, event: pageVisit("other.org") })).body,
      ),
    ).toMatchObject({ decision: "drop", trace: { decidedBy: "default_policy" } });
  });

  it("applies transforms and process rules, and a saved drop rule beats a draft allow", async () => {
    await create(
      a,
      rule({
        name: "no secrets",
        priority: 1,
        then: [{ action: "drop" }],
        when: {
          all: [{ field: "data.path", op: "starts_with", value: "/secret" }],
        },
      }),
    );
    const draft = rule({
      name: "coarse",
      priority: 20,
      when: {},
      then: [{ action: "allow" }, { action: "coarsen", segments: 1 }],
    });
    const coarse = testRuleResponseSchema.parse(
      (await test(a, { ...base, rule: draft, event: pageVisit("example.com", "/a/b/c") })).body,
    );
    expect(coarse).toMatchObject({ decision: "allow", event: { data: { path: "/a" } } });

    const dropped = testRuleResponseSchema.parse(
      (await test(a, { ...base, rule: draft, event: pageVisit("example.com", "/secret/x") })).body,
    );
    expect(dropped.decision).toBe("drop");
  });

  it("onlyRule ignores the saved rules, and replaceRuleId swaps one out", async () => {
    const { rule: stored } = await create(a, rule({ then: [{ action: "drop" }] }));
    const allow = rule({ then: [{ action: "allow" }] });
    const event = pageVisit("github.com");

    const kept = testRuleResponseSchema.parse(
      (await test(a, { ...base, rule: allow, event })).body,
    );
    expect(kept.decision).toBe("drop"); // the saved drop wins over the draft allow

    const alone = testRuleResponseSchema.parse(
      (await test(a, { ...base, rule: allow, onlyRule: true, event })).body,
    );
    expect(alone.decision).toBe("allow");

    const replaced = testRuleResponseSchema.parse(
      (await test(a, { ...base, rule: allow, replaceRuleId: stored.id, event })).body,
    );
    expect(replaced).toMatchObject({ decision: "allow", trace: { decidedBy: stored.id } });
  });

  it("an invalid event or draft is an error result or a 400, never a pass", async () => {
    const bad = testRuleResponseSchema.parse(
      (await test(a, { ...base, defaultPolicy: "allow", event: { type: "browser.page_visited" } }))
        .body,
    );
    expect(bad).toEqual({ decision: "error", reason: "invalid_event" });
    expect(
      (await test(a, { ...base, event: pageVisit("a.com"), rule: rule({ priority: -1 }) })).status,
    ).toBe(400);
    expect(
      (await test(a, { ...base, event: pageVisit("a.com"), replaceRuleId: MISSING })).status,
    ).toBe(400);
  });

  it("stores and counts nothing", async () => {
    await create(a);
    const before = await tenantState(testDb.pool, a.userId);
    const events = (await testDb.pool.query("select count(*)::int as n from events")).rows;
    await test(a, { ...base, event: pageVisit("github.com") });
    await test(a, { ...base, event: pageVisit("other.org") });
    expect(await tenantState(testDb.pool, a.userId)).toEqual(before);
    expect((await testDb.pool.query("select count(*)::int as n from events")).rows).toEqual(events);
    expect(await versionRows(a.userId)).toEqual([{ version: 1 }]);
  });

  it("runs only the caller's rules", async () => {
    await create(a);
    const res = await test(b, { ...base, event: pageVisit("github.com") });
    expect(testRuleResponseSchema.parse(res.body)).toMatchObject({
      decision: "drop",
      trace: { ruleSetVersion: 0, decidedBy: "default_policy" },
    });
  });

  it("an unknown replaceRuleId and another user's rule id answer the same 404", async () => {
    const { rule: theirs } = await create(b);
    const draft = rule();
    const body = (id: string) => ({
      ...base,
      event: pageVisit("github.com"),
      rule: draft,
      replaceRuleId: id,
    });
    const foreign = await test(a, body(theirs.id));
    const unknown = await test(a, body(MISSING));
    expect(foreign.status).toBe(404);
    expect(foreign.status).toBe(unknown.status);
    expect(foreign.body).toEqual(unknown.body);
    expect(foreign.body.code).toBe("rule.not_found");
  });
});

describe("cross-tenant", () => {
  it("B cannot read, replace or delete A's rule: 404, the same as an unknown id, A unchanged", async () => {
    const { rule: theirs } = await create(a);
    const before = await tenantState(testDb.pool, a.userId);
    const historyBefore = await historyRows(a.userId);

    const attempts = [
      (id: string) => as(b).get(`/v1/rules/${id}`),
      (id: string) => as(b).put(`/v1/rules/${id}`, rule({ name: "hijacked" })),
      (id: string) => as(b).delete(`/v1/rules/${id}`),
    ];
    for (const attempt of attempts) {
      const foreign = await attempt(theirs.id);
      const unknown = await attempt(MISSING);
      expect(foreign.status).toBe(404);
      expect(String(foreign.headers["content-type"])).toMatch(PROBLEM_JSON);
      expect(foreign.body).toEqual(unknown.body);
      expect(foreign.body.code).toBe("rule.not_found");
    }

    expect(await tenantState(testDb.pool, a.userId)).toEqual(before);
    expect(await historyRows(a.userId)).toEqual(historyBefore);
    // A refused change may leave an empty rule_sets row (it is created to be locked): version 0.
    expect((await versionRows(b.userId)).every((row) => row.version === 0)).toBe(true);
    expect(ruleListResponseSchema.parse((await as(b).get("/v1/rules")).body)).toEqual({
      version: 0,
      rules: [],
    });
  });

  it("a rule created while naming the other user in the query belongs to the caller", async () => {
    const res = await http()
      .post(`/v1/rules?userId=${b.userId}`)
      .set("Cookie", a.cookie)
      .set("X-User-Id", b.userId)
      .send(rule());
    expect(res.status).toBe(201);
    const owners = await testDb.pool.query("select distinct user_id from rules");
    expect(owners.rows).toEqual([{ user_id: a.userId }]);
  });

  it("each user has their own version counter and history", async () => {
    await create(a);
    await create(a);
    await create(b);
    expect(await versionRows(a.userId)).toEqual([{ version: 2 }]);
    expect(await versionRows(b.userId)).toEqual([{ version: 1 }]);
    expect(await historyRows(b.userId)).toHaveLength(1);
  });
});
