/**
 * M1-05 ingest decisions without a database: per-item planning (parse, age window, clamping,
 * repeats in one batch), results from the stored set, counters, the hourly bucket, and the
 * service's whole-request validation. The real insert and upsert are covered by *.int.spec.ts.
 */
import { randomUUID } from "node:crypto";
import { ingestBatchResponseSchema, type Rule } from "@personal-api/contracts";
import { compileRuleSet } from "@personal-api/rules";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import { AppException } from "../../platform/errors/problem";
import type { RuleSetProvider } from "../rules/rule-set.provider";
import type {
  Caller,
  IngestionCounts,
  IngestRepository,
  StoreBatchInput,
} from "./ingest.repository";
import {
  countResults,
  type Enforcement,
  hourBucket,
  INGEST_MAX_EVENT_AGE_MS,
  INGEST_MAX_FUTURE_SKEW_MS,
  IngestService,
  type ItemPlan,
  planBatch,
  toResults,
} from "./ingest.service";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const USER = "user-1";
const INTEGRATION = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";
const KEY = "0192f1c2-7c1e-7a3b-9f00-2d3e4f5a6b7c";

const RULE_A = "0192f1c2-7c1e-7a3b-9f00-00000000000a";
const RULE_B = "0192f1c2-7c1e-7a3b-9f00-00000000000b";

function rulesOf(version: number, rules: readonly unknown[]) {
  const result = compileRuleSet({ version, rules: rules as Rule[] });
  if (!result.ok) throw new Error("rules did not compile");
  return { version, compiled: result.ruleSet };
}

function rule(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    enabled: true,
    priority: 10,
    stage: "collect",
    when: {},
    then: [{ action: "allow" }],
    ...overrides,
  };
}

const HTTP_ALLOW: Caller = { kind: "http", defaultPolicy: "allow" };
const ALLOW_ALL: Enforcement = { caller: HTTP_ALLOW, rules: rulesOf(0, []) };

const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

function visit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { data, ...rest } = overrides;
  return {
    id: randomUUID(),
    type: "browser.page_visited",
    typeVersion: 1,
    occurredAt: at(-60_000),
    data: {
      domain: "example.com",
      path: "/a",
      transition: "link",
      tabRef: "tab-ref-12345678",
      ...(data as Record<string, unknown> | undefined),
    },
    ...rest,
  };
}

const kinds = (plan: ItemPlan[]) => plan.map((item) => item.kind);

describe("planBatch", () => {
  it("rejects each invalid item with its parseEvent code, in request order", () => {
    const plan = planBatch(
      [
        visit(),
        { nope: true },
        visit({ type: "browser.unknown" }),
        visit({ typeVersion: 9 }),
        visit({ data: { domain: "example.com", path: "/a?q=1", tabRef: "tab-ref-12345678" } }),
      ],
      NOW,
      ALLOW_ALL,
    );
    expect(plan.map((item) => (item.kind === "rejected" ? item.code : item.kind))).toEqual([
      "store",
      "ingest.envelope_invalid",
      "ingest.type_unknown",
      "ingest.type_version_unknown",
      "ingest.payload_invalid",
    ]);
  });

  it("echoes a valid id on a rejection, lowercased, and none for a malformed one", () => {
    const id = randomUUID();
    const [wrongType, badId, notObject] = planBatch(
      [visit({ id: id.toUpperCase(), type: "x.y" }), visit({ id: "nope" }), null],
      NOW,
      ALLOW_ALL,
    );
    expect(wrongType).toEqual({ kind: "rejected", code: "ingest.type_unknown", id });
    expect(badId).toEqual({ kind: "rejected", code: "ingest.envelope_invalid" });
    expect(notObject).toEqual({ kind: "rejected", code: "ingest.envelope_invalid" });
  });

  it("accepts exactly 90 days old and rejects 1 ms older with ingest.occurred_at_too_old", () => {
    const old = visit({ occurredAt: at(-INGEST_MAX_EVENT_AGE_MS - 1) });
    const plan = planBatch(
      [visit({ occurredAt: at(-INGEST_MAX_EVENT_AGE_MS) }), old],
      NOW,
      ALLOW_ALL,
    );
    expect(plan[0]?.kind).toBe("store");
    expect(plan[1]).toEqual({ kind: "rejected", code: "ingest.occurred_at_too_old", id: old.id });
  });

  it("lets a parseEvent code win over the age check", () => {
    const [item] = planBatch(
      [
        visit({
          occurredAt: at(-INGEST_MAX_EVENT_AGE_MS - 86_400_000),
          data: { domain: "example.com", path: "no-slash", tabRef: "tab-ref-12345678" },
        }),
      ],
      NOW,
      ALLOW_ALL,
    );
    expect(item).toMatchObject({ kind: "rejected", code: "ingest.payload_invalid" });
  });

  it("keeps exactly 5 minutes ahead as sent and clamps 1 ms more to receivedAt", () => {
    const [kept, clamped] = planBatch(
      [
        visit({ occurredAt: at(INGEST_MAX_FUTURE_SKEW_MS) }),
        visit({ occurredAt: at(INGEST_MAX_FUTURE_SKEW_MS + 1) }),
      ],
      NOW,
      ALLOW_ALL,
    );
    expect(kept).toMatchObject({
      kind: "store",
      event: { occurredAt: new Date(at(INGEST_MAX_FUTURE_SKEW_MS)), clientOccurredAt: null },
    });
    expect(clamped).toMatchObject({
      kind: "store",
      event: {
        occurredAt: NOW,
        receivedAt: NOW,
        clientOccurredAt: new Date(at(INGEST_MAX_FUTURE_SKEW_MS + 1)),
      },
    });
  });

  it("maps the validated envelope to a row, with receivedAt from the given clock time", () => {
    const event = visit();
    const [item] = planBatch([event], NOW, ALLOW_ALL);
    expect(item).toEqual({
      kind: "store",
      event: {
        clientEventId: event.id,
        type: "browser.page_visited",
        typeVersion: 1,
        occurredAt: new Date(event.occurredAt as string),
        clientOccurredAt: null,
        receivedAt: NOW,
        data: event.data,
        tags: [],
        trace: { ruleSetVersion: 0, matched: [], decidedBy: "default_policy" },
        expiresAt: null,
      },
    });
  });

  it("stores only the first valid copy of an id; later valid copies are repeats", () => {
    const id = randomUUID();
    const plan = planBatch(
      [visit({ id, type: "x.y" }), visit({ id }), visit({ id: id.toUpperCase() }), visit({ id })],
      NOW,
      ALLOW_ALL,
    );
    expect(kinds(plan)).toEqual(["rejected", "store", "repeat", "repeat"]);
  });

  it("never mutates its input", () => {
    const event = visit({ occurredAt: at(INGEST_MAX_FUTURE_SKEW_MS + 1) });
    const copy = structuredClone(event);
    planBatch([event], NOW, ALLOW_ALL);
    expect(event).toEqual(copy);
  });
});

describe("toResults", () => {
  it("answers accepted for stored ids, duplicate otherwise, and keeps request order", () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const plan = planBatch(
      [visit({ id: a }), visit({ id: b }), visit({ id: a }), {}],
      NOW,
      ALLOW_ALL,
    );
    expect(toResults(plan, new Set([a]))).toEqual([
      { id: a, status: "accepted" },
      { id: b, status: "duplicate" },
      { id: a, status: "duplicate" },
      { status: "rejected", code: "ingest.envelope_invalid" },
    ]);
  });

  it("answers dropped with the id alone, and always matches the strict response contract", () => {
    const enforcement: Enforcement = {
      caller: { ...HTTP_ALLOW, defaultPolicy: "deny" },
      rules: rulesOf(0, []),
    };
    const plan = planBatch([visit(), visit({ type: "x.y" }), {}, 7], NOW, enforcement);
    const results = toResults(plan, new Set());
    expect(results.map((r) => r.status)).toEqual(["dropped", "rejected", "rejected", "rejected"]);
    expect(Object.keys(results[0] ?? {}).sort()).toEqual(["id", "status"]);
    expect(ingestBatchResponseSchema.safeParse({ results }).success).toBe(true);
  });
});

describe("planBatch: the rules", () => {
  const deny: Caller = { kind: "http", defaultPolicy: "deny" };

  it("a dropped plan names who decided and carries no event", () => {
    const event = visit();
    const byDefault = planBatch([event], NOW, { caller: deny, rules: rulesOf(1, []) })[0];
    const byRule = planBatch([event], NOW, {
      caller: HTTP_ALLOW,
      rules: rulesOf(1, [rule(RULE_A, { then: [{ action: "drop" }] })]),
    })[0];
    expect(byDefault).toEqual({ kind: "dropped", id: event.id, decidedBy: "default_policy" });
    expect(byRule).toEqual({ kind: "dropped", id: event.id, decidedBy: RULE_A });
  });

  it("stores the rules' output: coarsened data, tags, and a retention counted from receivedAt", () => {
    const rules = rulesOf(3, [
      rule(RULE_A, { then: [{ action: "coarsen", segments: 0 }, { action: "allow" }] }),
      rule(RULE_B, {
        stage: "process",
        then: [
          { action: "tag", tag: "x" },
          { action: "set_retention", days: 2 },
        ],
      }),
    ]);
    const [item] = planBatch([visit()], NOW, { caller: deny, rules });
    if (item?.kind !== "store") throw new Error("expected store");
    expect(item.event.data).toMatchObject({ path: "/" });
    expect(item.event.tags).toEqual(["x"]);
    expect(item.event.expiresAt).toEqual(new Date(NOW.getTime() + 2 * 86_400_000));
    expect(item.event.trace).toEqual({
      ruleSetVersion: 3,
      matched: [
        { ruleId: RULE_A, actions: ["coarsen", "allow"] },
        { ruleId: RULE_B, actions: ["tag", "set_retention"] },
      ],
      decidedBy: RULE_A,
    });
  });

  it("a rule set that could not be loaded rejects every valid item with ingest.rule_error", () => {
    const plan = planBatch([visit(), visit(), {}], NOW, {
      caller: HTTP_ALLOW,
      rules: { version: 4, compiled: null },
    });
    expect(plan.map((p) => (p.kind === "rejected" ? p.code : p.kind))).toEqual([
      "ingest.rule_error",
      "ingest.rule_error",
      "ingest.envelope_invalid",
    ]);
  });

  it("an engine failure is ingest.rule_error, never a store", () => {
    const broken = { version: 1, compiled: { version: 1, collect: [{}], process: [] } };
    const [item] = planBatch([visit()], NOW, {
      caller: HTTP_ALLOW,
      rules: broken as unknown as Enforcement["rules"],
    });
    expect(item).toMatchObject({ kind: "rejected", code: "ingest.rule_error" });
  });

  describe("an extension event that carries the server's current rule-set version", () => {
    const meta = (ruleSetVersion: number) => ({
      meta: { ruleSetVersion, client: "pa-extension/1" },
    });
    const extension: Caller = { kind: "browser-extension", defaultPolicy: "deny" };
    const workOnly = rule(RULE_A, {
      when: { all: [{ field: "data.path", op: "starts_with", value: "/work/" }] },
    });
    const rewritten = (version: number) =>
      visit({ data: { domain: "example.com", path: "/work" }, ...meta(version) });

    it.each([
      ["the current version", 2, "store"],
      ["a stale version", 1, "dropped"],
      ["a newer version", 3, "dropped"],
    ])("%s", (_name, claimed, expected) => {
      const [item] = planBatch([rewritten(claimed)], NOW, {
        caller: extension,
        rules: rulesOf(2, [workOnly]),
      });
      expect(item?.kind).toBe(expected);
    });

    it("is not trusted at version 0, with no collect rules, from an http source, or with no meta", () => {
      const processOnly = rule(RULE_B, { stage: "process", then: [{ action: "tag", tag: "x" }] });
      const cases: [Caller, ReturnType<typeof rulesOf>, Record<string, unknown>][] = [
        [extension, rulesOf(0, []), rewritten(0)],
        [extension, rulesOf(2, [processOnly]), rewritten(2)],
        [{ ...extension, kind: "http" }, rulesOf(2, [workOnly]), rewritten(2)],
        [
          extension,
          rulesOf(2, [workOnly]),
          visit({ data: { domain: "example.com", path: "/work" } }),
        ],
      ];
      for (const [caller, rules, event] of cases) {
        expect(planBatch([event], NOW, { caller, rules })[0]?.kind).toBe("dropped");
      }
    });
  });
});

describe("countResults", () => {
  function counted(enforcement: Enforcement, items: unknown[], stored: string[] = []) {
    const plan = planBatch(items, NOW, enforcement);
    return countResults(plan, toResults(plan, new Set(stored)));
  }

  it("counts each status, keys rejections by error code and drops by the deciding rule", () => {
    const a = visit();
    const b = visit({ data: { domain: "blocked.example", path: "/x" } });
    const rules = rulesOf(1, [
      rule(RULE_A, {
        priority: 1,
        when: { all: [{ field: "data.domain", op: "eq", value: "blocked.example" }] },
        then: [{ action: "drop" }],
      }),
    ]);
    const counts = counted(
      { caller: HTTP_ALLOW, rules },
      [a, a, b, b, { nope: 1 }, visit({ type: "x.y" })],
      [a.id as string],
    );
    expect(counts).toEqual({
      accepted: 1,
      duplicate: 1,
      dropped: 2,
      rejected: 2,
      byReason: { [RULE_A]: 2, "ingest.envelope_invalid": 1, "ingest.type_unknown": 1 },
    });
  });

  it("counts a default-policy drop under default_policy and nothing from the event", () => {
    const counts = counted(
      { caller: { ...HTTP_ALLOW, defaultPolicy: "deny" }, rules: rulesOf(0, []) },
      [visit({ data: { domain: "sentinel.example", path: "/secret" } })],
    );
    expect(counts.byReason).toEqual({ default_policy: 1 });
    expect(JSON.stringify(counts)).not.toMatch(/sentinel|secret/);
  });

  it("leaves byReason empty when nothing was rejected or dropped", () => {
    expect(counted(ALLOW_ALL, [visit()], []).byReason).toEqual({});
  });
});

describe("hourBucket", () => {
  it.each([
    ["2026-10-14T12:00:00.000Z", "2026-10-14T12:00:00.000Z"],
    ["2026-10-14T12:34:56.789Z", "2026-10-14T12:00:00.000Z"],
    ["2026-10-14T12:59:59.999Z", "2026-10-14T12:00:00.000Z"],
    ["2026-10-14T23:59:59.999Z", "2026-10-14T23:00:00.000Z"],
  ])("puts %s in the %s bucket (UTC)", (time, bucket) => {
    expect(hourBucket(new Date(time)).toISOString()).toBe(bucket);
  });
});

describe("IngestService", () => {
  interface Call {
    userId: string;
    integrationId: string;
    batch: StoreBatchInput;
    counts: IngestionCounts;
  }

  /** Stores every id it has not seen before, like the real insert, and records each call. */
  function fakeRepository() {
    const seen = new Set<string>();
    const calls: Call[] = [];
    const repository = {
      async loadCaller(): Promise<Caller> {
        return HTTP_ALLOW;
      },
      async storeBatch(
        userId: string,
        integrationId: string,
        _keyId: string,
        batch: StoreBatchInput,
        summarize: (stored: ReadonlySet<string>) => IngestionCounts,
      ) {
        const stored = new Set<string>();
        for (const event of batch.events) {
          if (!seen.has(event.clientEventId)) stored.add(event.clientEventId);
          seen.add(event.clientEventId);
        }
        calls.push({ userId, integrationId, batch, counts: summarize(stored) });
        return stored;
      },
      async touchLastSeen() {
        return true;
      },
    };
    return { repository: repository as unknown as IngestRepository, calls };
  }

  function ruleSets(): RuleSetProvider {
    return { get: async () => ALLOW_ALL.rules } as unknown as RuleSetProvider;
  }

  function service() {
    const clock = new FakeClock(NOW);
    const fake = fakeRepository();
    return { ...fake, clock, ingest: new IngestService(fake.repository, ruleSets(), clock) };
  }

  it.each([
    ["no body", undefined],
    ["null", null],
    ["a bare array", [visit()]],
    ["no events key", {}],
    ["an empty events array", { events: [] }],
    ["101 events", { events: Array.from({ length: 101 }, () => visit()) }],
    ["an unknown top-level key", { events: [visit()], integrationId: INTEGRATION }],
  ])("refuses %s with one 400 ingest.batch_invalid and stores nothing", async (_name, body) => {
    const { ingest, calls } = service();
    const error = await ingest.ingestBatch(USER, INTEGRATION, KEY, body).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).getStatus()).toBe(400);
    expect((error as AppException).code).toBe("ingest.batch_invalid");
    expect(calls).toEqual([]);
  });

  it("does not echo the input in the batch_invalid problem", async () => {
    const { ingest } = service();
    const error = await ingest
      .ingestBatch(USER, INTEGRATION, KEY, {
        events: [visit({ data: { domain: "echo-check.example" } })],
        "sentinel-key": "sentinel-value",
      })
      .catch((e: unknown) => e);
    expect(JSON.stringify((error as AppException).extensions)).not.toMatch(/sentinel|echo/);
  });

  it("passes the caller's tenancy, the clock's hour bucket and only valid events to storage", async () => {
    const { ingest, calls, clock } = service();
    clock.set("2026-10-14T15:42:00.000Z");
    const event = visit({ occurredAt: "2026-10-14T15:00:00.000Z" });
    await ingest.ingestBatch(USER, INTEGRATION, KEY, { events: [event, { nope: 1 }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userId).toBe(USER);
    expect(calls[0]?.integrationId).toBe(INTEGRATION);
    expect(calls[0]?.batch.bucket.toISOString()).toBe("2026-10-14T15:00:00.000Z");
    expect(calls[0]?.batch.events.map((e) => e.clientEventId)).toEqual([event.id]);
    expect(calls[0]?.batch.events[0]?.receivedAt.toISOString()).toBe("2026-10-14T15:42:00.000Z");
  });

  it("returns results whose counters are exactly what storage records", async () => {
    const { ingest, calls } = service();
    const id = randomUUID();
    const first = await ingest.ingestBatch(USER, INTEGRATION, KEY, {
      events: [visit({ id }), visit({ id }), visit({ type: "x.y" })],
    });
    const second = await ingest.ingestBatch(USER, INTEGRATION, KEY, { events: [visit({ id })] });
    expect(first.results.map((r) => r.status)).toEqual(["accepted", "duplicate", "rejected"]);
    expect(second.results.map((r) => r.status)).toEqual(["duplicate"]);
    expect(calls.map((call) => call.counts)).toEqual([
      {
        accepted: 1,
        duplicate: 1,
        dropped: 0,
        rejected: 1,
        byReason: { "ingest.type_unknown": 1 },
      },
      { accepted: 0, duplicate: 1, dropped: 0, rejected: 0, byReason: {} },
    ]);
  });

  it("still records the counters when every item was rejected", async () => {
    const { ingest, calls } = service();
    await ingest.ingestBatch(USER, INTEGRATION, KEY, { events: [{ nope: 1 }] });
    expect(calls[0]?.batch.events).toEqual([]);
    expect(calls[0]?.counts).toMatchObject({ rejected: 1, accepted: 0 });
  });

  it("answers the guard's 401 auth.invalid_key when the repository finds the key revoked", async () => {
    const clock = new FakeClock(NOW);
    const repository = {
      async loadCaller(): Promise<Caller> {
        return HTTP_ALLOW;
      },
      async storeBatch() {
        return null;
      },
      async touchLastSeen() {
        throw new Error("must not touch last_seen_at after a refusal");
      },
    } as unknown as IngestRepository;
    const error = await new IngestService(repository, ruleSets(), clock)
      .ingestBatch(USER, INTEGRATION, KEY, { events: [visit()] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).getStatus()).toBe(401);
    expect((error as AppException).code).toBe("auth.invalid_key");
  });

  it("answers 401 without loading rules or storing when the integration is gone", async () => {
    const repository = {
      async loadCaller() {
        return null;
      },
    } as unknown as IngestRepository;
    const rules = {
      get: async () => {
        throw new Error("must not load rules for a revoked caller");
      },
    } as unknown as RuleSetProvider;
    const error = await new IngestService(repository, rules, new FakeClock(NOW))
      .ingestBatch(USER, INTEGRATION, KEY, { events: [visit()] })
      .catch((e: unknown) => e);
    expect((error as AppException).getStatus()).toBe(401);
    expect((error as AppException).code).toBe("auth.invalid_key");
  });
});

describe("IngestService.getConfig (M4-R S2)", () => {
  function serviceFor(caller: Caller) {
    const repository = {
      async loadCaller() {
        return caller;
      },
    } as unknown as IngestRepository;
    const loaded: string[] = [];
    const rules = {
      get: async (userId: string) => {
        loaded.push(userId);
        return rulesOf(3, [rule(RULE_A)]);
      },
    } as unknown as RuleSetProvider;
    return { ingest: new IngestService(repository, rules, new FakeClock(NOW)), loaded };
  }

  it("answers a browser extension's key with the rules, the version and its policy", async () => {
    const { ingest } = serviceFor({ kind: "browser-extension", defaultPolicy: "deny" });
    const { config } = await ingest.getConfig(USER, INTEGRATION);
    expect(config.ruleSetVersion).toBe(3);
    expect(config.defaultPolicy).toBe("deny");
    expect(config.rules.map((r) => r.id)).toEqual([RULE_A]);
  });

  it("refuses an http integration's key with a 403 problem and reads no rules", async () => {
    const { ingest, loaded } = serviceFor({ kind: "http", defaultPolicy: "allow" });
    const error = await ingest.getConfig(USER, INTEGRATION).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).getStatus()).toBe(403);
    expect((error as AppException).code).toBe("ingest.config_unsupported");
    expect(loaded).toEqual([]);
  });
});
