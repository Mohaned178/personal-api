/**
 * M4-06 `GET /v1/ingest/config`, over HTTP against the real application (Testcontainers; CI runs
 * these, Docker may be off locally), using the two-user fixture.
 *
 * "Done when" (derived, the task line has none): the ingest key's own integration gets its
 * enabled collect-stage rules, the rule-set version and its default policy (no process rules, no
 * disabled rules, in evaluation order); the answer carries a strong ETag and `If-None-Match`
 * (also weak, a list, `*`) gives 304 with no body; a rule change or a policy change gives a new
 * ETag; two users never see each other's rules; a rule set that cannot be loaded is a 409
 * `ingest.rule_error` with no rules in it; a key without ingest rights is refused; the key of an
 * `http` integration is refused too, since only a browser extension applies rules (M4-R S2).
 */

import type { RuleDefinition } from "@personal-api/contracts";
import { ingestConfigResponseSchema } from "@personal-api/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FORMER_READ_KEY } from "../../../test/former-read-key";
import {
  type IngestHarness,
  PROBLEM_JSON,
  setDefaultPolicy,
  startIngestHarness,
} from "../../../test/ingest-helpers";

import { generateApiKey } from "../keys/key-generation";
import { RulesService } from "../rules/rules.service";

const CONFIG_PATH = "/v1/ingest/config";

let h: IngestHarness;

beforeAll(async () => {
  h = await startIngestHarness();
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

/** The fixture's integrations are `http`; the config route is for browser extensions. */
async function setKind(integrationId: string, kind: "browser-extension" | "http") {
  await h.testDb.pool.query("update integrations set kind = $1 where id = $2", [
    kind,
    integrationId,
  ]);
}

beforeEach(async () => {
  await h.reset();
  await setDefaultPolicy(h.testDb.pool, "deny");
  await setKind(h.a.integrationId, "browser-extension");
  await setKind(h.b.integrationId, "browser-extension");
});

function ruleFor(name: string, overrides: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    name,
    enabled: true,
    priority: 10,
    stage: "collect",
    when: { all: [{ field: "data.domain", op: "eq", value: "example.com" }] },
    then: [{ action: "allow" }],
    ...overrides,
  } as RuleDefinition;
}

const addRule = (userId: string, definition: RuleDefinition) =>
  h.app.get(RulesService).create(userId, definition);

function getConfig(key: string | undefined, headers: Record<string, string> = {}) {
  let req = request(h.app.getHttpServer()).get(CONFIG_PATH);
  if (key) req = req.set("Authorization", `Bearer ${key}`);
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  return req;
}

describe("GET /v1/ingest/config", () => {
  it("answers version 0, the policy and no rules for a user without rules", async () => {
    const res = await getConfig(h.a.ingestKey);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ruleSetVersion: 0, defaultPolicy: "deny", rules: [] });
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["cache-control"]).toBe("private, no-cache");
  });

  it("answers the enabled collect rules in evaluation order, validated by the contract", async () => {
    await addRule(h.a.userId, ruleFor("late", { priority: 50 }));
    await addRule(h.a.userId, ruleFor("early", { priority: 5 }));
    await addRule(h.a.userId, ruleFor("off", { enabled: false }));
    await addRule(
      h.a.userId,
      ruleFor("tagger", { stage: "process", then: [{ action: "tag", tag: "secret-tag" }] }),
    );

    const res = await getConfig(h.a.ingestKey);
    expect(res.status).toBe(200);
    const config = ingestConfigResponseSchema.parse(res.body);
    expect(config.ruleSetVersion).toBe(4);
    expect(config.defaultPolicy).toBe("deny");
    expect(config.rules.map((rule) => rule.name)).toEqual(["early", "late"]);
    // Process-stage rules run on the server only: neither the rule nor its tag leaves it.
    expect(JSON.stringify(res.body)).not.toContain("secret-tag");
    expect(JSON.stringify(res.body)).not.toContain('"off"');
  });

  it("answers the policy of the key's own integration", async () => {
    await setDefaultPolicy(h.testDb.pool, "allow", h.a.integrationId);
    expect((await getConfig(h.a.ingestKey)).body.defaultPolicy).toBe("allow");
    expect((await getConfig(h.b.ingestKey)).body.defaultPolicy).toBe("deny");
  });
});

describe("who may ask", () => {
  it("refuses the key of an http integration with 403 ingest.config_unsupported", async () => {
    await addRule(h.a.userId, ruleFor("one"));
    await setKind(h.a.integrationId, "http");
    const res = await getConfig(h.a.ingestKey);
    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("ingest.config_unsupported");
    expect(JSON.stringify(res.body)).not.toContain("one");
    // The other user's extension key still works.
    expect((await getConfig(h.b.ingestKey)).status).toBe(200);
  });
});

describe("the ETag", () => {
  it("is a strong, quoted validator that repeats for an unchanged config", async () => {
    await addRule(h.a.userId, ruleFor("one"));
    const first = await getConfig(h.a.ingestKey);
    const second = await getConfig(h.a.ingestKey);
    expect(first.headers.etag).toMatch(/^"[A-Za-z0-9_-]{16,}"$/);
    expect(second.headers.etag).toBe(first.headers.etag);
  });

  it.each([
    ["the exact tag", (tag: string) => tag],
    ["a weak form of it", (tag: string) => `W/${tag}`],
    ["a list that contains it", (tag: string) => `"other", ${tag}`],
    ["a star", () => "*"],
  ])("answers 304 with no body for %s in If-None-Match", async (_label, header) => {
    await addRule(h.a.userId, ruleFor("one"));
    const tag = (await getConfig(h.a.ingestKey)).headers.etag as string;
    const res = await getConfig(h.a.ingestKey, { "If-None-Match": header(tag) });
    expect(res.status).toBe(304);
    expect(res.text).toBe("");
    expect(res.headers.etag).toBe(tag);
  });

  it("answers 200 for a tag that is not the current one", async () => {
    await addRule(h.a.userId, ruleFor("one"));
    const res = await getConfig(h.a.ingestKey, { "If-None-Match": '"stale"' });
    expect(res.status).toBe(200);
  });

  it("changes when a rule changes, and a 304 stops once it does", async () => {
    await addRule(h.a.userId, ruleFor("one"));
    const before = (await getConfig(h.a.ingestKey)).headers.etag as string;
    await addRule(h.a.userId, ruleFor("two"));
    const res = await getConfig(h.a.ingestKey, { "If-None-Match": before });
    expect(res.status).toBe(200);
    expect(res.headers.etag).not.toBe(before);
  });

  it("changes when only the default policy changes (rule-format open item 5)", async () => {
    await addRule(h.a.userId, ruleFor("one"));
    const before = await getConfig(h.a.ingestKey);
    await setDefaultPolicy(h.testDb.pool, "allow", h.a.integrationId);
    const after = await getConfig(h.a.ingestKey, {
      "If-None-Match": before.headers.etag as string,
    });
    expect(after.status).toBe(200);
    expect(after.headers.etag).not.toBe(before.headers.etag);
    expect(after.body.ruleSetVersion).toBe(before.body.ruleSetVersion);
  });

  it("is not shared between users at the same version with different rules", async () => {
    await addRule(h.a.userId, ruleFor("same version", { priority: 1 }));
    await addRule(h.b.userId, ruleFor("same version", { priority: 2 }));
    const a = await getConfig(h.a.ingestKey);
    const res = await getConfig(h.b.ingestKey, { "If-None-Match": a.headers.etag as string });
    expect(res.status).toBe(200);
  });
});

describe("tenancy", () => {
  it("gives each key its own user's rules only", async () => {
    await addRule(h.a.userId, ruleFor("rule of a"));
    await addRule(h.b.userId, ruleFor("rule of b"));
    const a = await getConfig(h.a.ingestKey);
    const b = await getConfig(h.b.ingestKey);
    expect(a.body.rules.map((r: { name: string }) => r.name)).toEqual(["rule of a"]);
    expect(b.body.rules.map((r: { name: string }) => r.name)).toEqual(["rule of b"]);
    expect(JSON.stringify(a.body)).not.toContain("rule of b");
  });

  it("ignores a user or integration named in the query or headers", async () => {
    await addRule(h.b.userId, ruleFor("rule of b"));
    const res = await request(h.app.getHttpServer())
      .get(`${CONFIG_PATH}?userId=${h.b.userId}&integrationId=${h.b.integrationId}`)
      .set("Authorization", `Bearer ${h.a.ingestKey}`)
      .set("X-User-Id", h.b.userId);
    expect(res.status).toBe(200);
    expect(res.body.rules).toEqual([]);
  });
});

describe("authentication", () => {
  it.each([
    ["no key", () => undefined],
    ["a read key", () => FORMER_READ_KEY],
    ["a made-up ingest key", () => generateApiKey().plaintext],
  ])("refuses %s with 401", async (_label, key) => {
    await addRule(h.a.userId, ruleFor("one"));
    const res = await getConfig(key());
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(JSON.stringify(res.body)).not.toContain("one");
  });

  it("refuses a session cookie", async () => {
    const res = await request(h.app.getHttpServer()).get(CONFIG_PATH).set("Cookie", h.a.cookie);
    expect(res.status).toBe(401);
  });

  it("refuses a revoked key", async () => {
    await h.testDb.pool.query("update api_keys set revoked_at = now() where id = $1", [
      h.a.ingestKeyId,
    ]);
    expect((await getConfig(h.a.ingestKey)).status).toBe(401);
    await h.testDb.pool.query("update api_keys set revoked_at = null");
  });
});

describe("a rule set that cannot be loaded fails closed", () => {
  it("is a 409 ingest.rule_error with no rules in the body", async () => {
    await addRule(h.a.userId, ruleFor("fine"));
    await h.testDb.pool.query(
      `update rules set definition = '{"bogus": true}'::jsonb where user_id = $1`,
      [h.a.userId],
    );
    const res = await getConfig(h.a.ingestKey);
    expect(res.status).toBe(409);
    expect(res.headers["content-type"]).toMatch(PROBLEM_JSON);
    expect(res.body.code).toBe("ingest.rule_error");
    expect(res.body.rules).toBeUndefined();
  });
});
