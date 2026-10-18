/**
 * M4-05 rule enforcement at `POST /v1/ingest/events`, over HTTP against the real application
 * (Testcontainers; CI runs these, Docker may be off locally), using the two-user fixture.
 *
 * "Done when" (derived, the task line has none): the integration's default policy decides what no
 * rule decides; a rule change takes effect on the next batch (cache invalidated by version);
 * redact, coarsen, tags, retention and a trace reach the stored row; a dropped event leaves
 * nothing but counters (per rule, or `default_policy`); two users at the same rule-set version get
 * their own rules; an extension event that carries the current version is not dropped by the
 * policy alone (open item 1), but a client that claims version 0, a stale version or an `http`
 * source gets the full evaluation; a rule set that cannot be loaded or an engine failure is
 * `rejected(ingest.rule_error)` and stores nothing.
 */
import type { RuleDefinition } from "@personal-api/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DAY_MS,
  eventRows,
  expectResults,
  FIXED_NOW,
  type IngestHarness,
  logRows,
  pageVisit,
  postEvents,
  SENTINEL_DOMAIN,
  SENTINEL_PATH,
  setDefaultPolicy,
  startIngestHarness,
} from "../../../test/ingest-helpers";
import { IntegrationsService } from "../integrations/integrations.service";
import { RulesService } from "../rules/rules.service";

let h: IngestHarness;

beforeAll(async () => {
  h = await startIngestHarness();
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.reset();
  await setDefaultPolicy(h.testDb.pool, "deny");
});

function ruleFor(domain: string, overrides: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    name: `rule for ${domain}`,
    enabled: true,
    priority: 10,
    stage: "collect",
    when: { all: [{ field: "data.domain", op: "eq", value: domain }] },
    then: [{ action: "allow" }],
    ...overrides,
  } as RuleDefinition;
}

const addRule = (userId: string, definition: RuleDefinition) =>
  h.app.get(RulesService).create(userId, definition);

const statusesOf = (results: { status: string }[]) => results.map((r) => r.status);

describe("the default policy", () => {
  it("drops every event when no rule decides and the policy is deny, storing counters only", async () => {
    const event = pageVisit({ data: { domain: SENTINEL_DOMAIN, path: SENTINEL_PATH } });
    const results = expectResults(await postEvents(h.app, h.a.ingestKey, [event]));
    expect(results).toEqual([{ id: event.id, status: "dropped" }]);

    expect(await eventRows(h.testDb.pool)).toEqual([]);
    const [log] = await logRows(h.testDb.pool, h.a.userId);
    expect(log).toMatchObject({ accepted: 0, dropped: 1, rejected: 0 });
    expect(log?.by_reason).toEqual({ default_policy: 1 });
    // Invariant 2: no payload anywhere in the log.
    const dump = JSON.stringify((await h.testDb.pool.query("select * from ingestion_log")).rows);
    expect(dump).not.toContain(SENTINEL_DOMAIN);
    expect(dump).not.toContain(SENTINEL_PATH);
  });

  it("stores events when the policy is allow and no rule decides, traced to the default policy", async () => {
    await setDefaultPolicy(h.testDb.pool, "allow", h.a.integrationId);
    const results = expectResults(await postEvents(h.app, h.a.ingestKey, [pageVisit()]));
    expect(statusesOf(results)).toEqual(["accepted"]);
    const [row] = await eventRows(h.testDb.pool, h.a.userId);
    expect(row?.trace).toEqual({ ruleSetVersion: 0, matched: [], decidedBy: "default_policy" });
    expect(row?.tags).toEqual([]);
    expect(row?.expires_at).toBeNull();
  });
});

describe("rules decide", () => {
  it("an allow rule stores the event with a trace naming the rule and the rule-set version", async () => {
    const { rule } = await addRule(h.a.userId, ruleFor("example.com"));
    const results = expectResults(
      await postEvents(h.app, h.a.ingestKey, [
        pageVisit(),
        pageVisit({ data: { domain: "other.example" } }),
      ]),
    );
    expect(statusesOf(results)).toEqual(["accepted", "dropped"]);
    const rows = await eventRows(h.testDb.pool, h.a.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.trace).toEqual({
      ruleSetVersion: 1,
      matched: [{ ruleId: rule.id, actions: ["allow"] }],
      decidedBy: rule.id,
    });
  });

  it("a rule change takes effect on the next batch: allow, then replaced by drop, then deleted", async () => {
    const { rule } = await addRule(h.a.userId, ruleFor("example.com"));
    expect(
      statusesOf(expectResults(await postEvents(h.app, h.a.ingestKey, [pageVisit()]))),
    ).toEqual(["accepted"]);

    await h.app
      .get(RulesService)
      .replace(h.a.userId, rule.id, ruleFor("example.com", { then: [{ action: "drop" }] }));
    expect(
      statusesOf(expectResults(await postEvents(h.app, h.a.ingestKey, [pageVisit()]))),
    ).toEqual(["dropped"]);
    expect((await logRows(h.testDb.pool, h.a.userId))[0]?.by_reason).toEqual({ [rule.id]: 1 });

    await h.app.get(RulesService).remove(h.a.userId, rule.id);
    expect(
      statusesOf(expectResults(await postEvents(h.app, h.a.ingestKey, [pageVisit()]))),
    ).toEqual(["dropped"]);
    // Per-rule counters add up across batches; the deleted rule's count stays, and the default
    // policy gets its own.
    expect((await logRows(h.testDb.pool, h.a.userId))[0]?.by_reason).toEqual({
      [rule.id]: 1,
      default_policy: 1,
    });
    expect(await eventRows(h.testDb.pool, h.a.userId)).toHaveLength(1);
  });

  it("redact and coarsen reach the stored row, not the original", async () => {
    await addRule(
      h.a.userId,
      ruleFor("example.com", {
        then: [
          { action: "coarsen", segments: 1 },
          { action: "redact", field: "data.transition" },
          { action: "allow" },
        ],
      }),
    );
    const [result] = expectResults(
      await postEvents(h.app, h.a.ingestKey, [
        pageVisit({ data: { path: "/work/projectA/doc", transition: "typed" } }),
      ]),
    );
    expect(result?.status).toBe("accepted");
    const [row] = await eventRows(h.testDb.pool, h.a.userId);
    expect(row?.data).toEqual({
      domain: "example.com",
      path: "/work",
      tabRef: "tab-ref-12345678",
    });
  });

  it("process rules add tags and a retention, counted from receivedAt", async () => {
    await addRule(h.a.userId, ruleFor("example.com"));
    await addRule(
      h.a.userId,
      ruleFor("example.com", {
        stage: "process",
        then: [
          { action: "tag", tag: "work" },
          { action: "set_retention", days: 30 },
        ],
      }),
    );
    expectResults(await postEvents(h.app, h.a.ingestKey, [pageVisit()]));
    const [row] = await eventRows(h.testDb.pool, h.a.userId);
    expect(row?.tags).toEqual(["work"]);
    expect(row?.expires_at?.toISOString()).toBe(
      new Date(Date.parse(FIXED_NOW) + 30 * DAY_MS).toISOString(),
    );
  });

  it("a dropped event leaves its domain and path nowhere, also when its id is repeated", async () => {
    await addRule(h.a.userId, ruleFor(SENTINEL_DOMAIN, { then: [{ action: "drop" }] }));
    const event = pageVisit({ data: { domain: SENTINEL_DOMAIN, path: SENTINEL_PATH } });
    expect(
      statusesOf(expectResults(await postEvents(h.app, h.a.ingestKey, [event, event]))),
    ).toEqual(["dropped", "dropped"]);
    expect(await eventRows(h.testDb.pool)).toEqual([]);
    const logs = JSON.stringify((await h.testDb.pool.query("select * from ingestion_log")).rows);
    expect(logs).not.toContain(SENTINEL_DOMAIN);
    expect(logs).not.toContain(SENTINEL_PATH);
  });
});

describe("tenants", () => {
  it("two users at the same rule-set version each get their own rules", async () => {
    await addRule(h.a.userId, ruleFor("example.com"));
    await addRule(h.b.userId, ruleFor("example.com", { then: [{ action: "drop" }] }));
    const event = pageVisit();
    const a = expectResults(await postEvents(h.app, h.a.ingestKey, [event]));
    const b = expectResults(await postEvents(h.app, h.b.ingestKey, [event]));
    expect(statusesOf(a)).toEqual(["accepted"]);
    expect(statusesOf(b)).toEqual(["dropped"]);
    expect(await eventRows(h.testDb.pool, h.b.userId)).toEqual([]);
    expect((await logRows(h.testDb.pool, h.b.userId))[0]?.by_reason).not.toHaveProperty(
      "default_policy",
    );
  });

  it("user B's rules never decide user A's events", async () => {
    await addRule(h.b.userId, ruleFor("example.com"));
    const results = expectResults(await postEvents(h.app, h.a.ingestKey, [pageVisit()]));
    expect(statusesOf(results)).toEqual(["dropped"]);
    expect(await eventRows(h.testDb.pool, h.a.userId)).toEqual([]);
  });
});

describe("events the extension already decided (open item 1)", () => {
  /** A second integration of user A that is a browser extension (a pairing code would mint the same key). */
  async function extension() {
    const created = await h.app
      .get(IntegrationsService)
      .create(h.a.userId, { kind: "http", name: "ext" });
    await h.testDb.pool.query("update integrations set kind = 'browser-extension' where id = $1", [
      created.integration.id,
    ]);
    return { key: created.ingestKey.key, integrationId: created.integration.id };
  }

  const rewriting = ruleFor("example.com", {
    when: {
      all: [
        { field: "data.domain", op: "eq", value: "example.com" },
        { field: "data.path", op: "starts_with", value: "/work/" },
      ],
    },
    then: [{ action: "coarsen", segments: 1 }, { action: "allow" }],
  });
  const coarsened = (version: number) =>
    pageVisit({
      data: { path: "/work" },
      extra: { meta: { ruleSetVersion: version, client: "pa-extension/0.1.0" } },
    });

  it("an event whose own rule rewrote what it reads is kept when it carries the current version", async () => {
    const ext = await extension();
    await addRule(h.a.userId, rewriting);
    const results = expectResults(await postEvents(h.app, ext.key, [coarsened(1)]));
    expect(statusesOf(results)).toEqual(["accepted"]);
    const [row] = await eventRows(h.testDb.pool, h.a.userId);
    expect(row?.data).toMatchObject({ path: "/work" });
    expect(row?.trace).toEqual({ ruleSetVersion: 1, matched: [], decidedBy: "client" });
  });

  it.each([
    ["a stale version", 5],
    ["version 0", 0],
  ])("%s gets the full evaluation: the policy drops it", async (_name, claimed) => {
    const ext = await extension();
    await addRule(h.a.userId, rewriting);
    const results = expectResults(await postEvents(h.app, ext.key, [coarsened(claimed)]));
    expect(statusesOf(results)).toEqual(["dropped"]);
    expect(await eventRows(h.testDb.pool, h.a.userId)).toEqual([]);
  });

  it("a user with no rules stores nothing even when the extension claims version 0", async () => {
    const ext = await extension();
    const results = expectResults(await postEvents(h.app, ext.key, [coarsened(0)]));
    expect(statusesOf(results)).toEqual(["dropped"]);
    expect(await eventRows(h.testDb.pool, h.a.userId)).toEqual([]);
  });

  it("an http source gets the full evaluation whatever version it claims", async () => {
    await addRule(h.a.userId, rewriting);
    const results = expectResults(await postEvents(h.app, h.a.ingestKey, [coarsened(1)]));
    expect(statusesOf(results)).toEqual(["dropped"]);
  });

  it("a deciding drop rule still drops an event that carries the current version", async () => {
    const ext = await extension();
    await addRule(h.a.userId, ruleFor("blocked.example", { then: [{ action: "drop" }] }));
    const event = pageVisit({
      data: { domain: "blocked.example" },
      extra: { meta: { ruleSetVersion: 1, client: "pa-extension/0.1.0" } },
    });
    const results = expectResults(await postEvents(h.app, ext.key, [event]));
    expect(statusesOf(results)).toEqual(["dropped"]);
  });
});

describe("rule errors fail closed", () => {
  async function breakRulesOf(userId: string) {
    await addRule(userId, ruleFor("example.com"));
    await h.testDb.pool.query(
      `update rules set definition = '{"bogus": true}'::jsonb where user_id = $1`,
      [userId],
    );
  }

  it("a stored rule that no longer fits the schema rejects every item with ingest.rule_error and stores nothing", async () => {
    await breakRulesOf(h.a.userId);
    const results = expectResults(
      await postEvents(h.app, h.a.ingestKey, [pageVisit(), pageVisit()]),
    );
    expect(results.map((r) => [r.status, r.code])).toEqual([
      ["rejected", "ingest.rule_error"],
      ["rejected", "ingest.rule_error"],
    ]);
    expect(await eventRows(h.testDb.pool)).toEqual([]);
    const [log] = await logRows(h.testDb.pool, h.a.userId);
    expect(log).toMatchObject({ accepted: 0, rejected: 2 });
    expect(log?.by_reason).toEqual({ "ingest.rule_error": 2 });
  });

  it("another user's batch is unaffected by a broken rule set", async () => {
    await breakRulesOf(h.a.userId);
    await setDefaultPolicy(h.testDb.pool, "allow", h.b.integrationId);
    const results = expectResults(await postEvents(h.app, h.b.ingestKey, [pageVisit()]));
    expect(statusesOf(results)).toEqual(["accepted"]);
  });
});
