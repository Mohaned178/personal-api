/**
 * M4-05 the per-user rule-set cache, without a database: reused while the version is unchanged,
 * rebuilt when it moves, kept apart per user, bounded, and closed (not guessed) when a stored rule
 * is broken.
 */
import type { Rule } from "@personal-api/contracts";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { MissingUserScopeError } from "../../platform/db/tenant-scope";
import { RULE_SET_CACHE_MAX_USERS, RuleSetProvider } from "./rule-set.provider";
import type { RulesRepository, StoredRuleSet } from "./rules.repository";

const RULE_ID = "0192f1c2-7c1e-7a3b-9f00-00000000000a";

function allowRule(id = RULE_ID): Rule {
  return {
    id,
    name: "allow",
    enabled: true,
    priority: 1,
    stage: "collect",
    when: {},
    then: [{ action: "allow" }],
  };
}

/** A repository whose answers the test sets per user, and that counts what the provider asks. */
function fakeRepository(initial: Record<string, StoredRuleSet> = {}) {
  const stored = new Map(Object.entries(initial));
  const calls = { readVersion: 0, list: 0 };
  let failList: unknown;
  const repository = {
    async readVersion(userId: string) {
      calls.readVersion += 1;
      return stored.get(userId)?.version ?? 0;
    },
    async list(userId: string) {
      calls.list += 1;
      if (failList !== undefined) throw failList;
      return stored.get(userId) ?? { version: 0, rules: [] };
    },
  } as unknown as RulesRepository;
  return {
    repository,
    calls,
    set: (userId: string, value: StoredRuleSet) => stored.set(userId, value),
    failListWith: (error: unknown) => {
      failList = error;
    },
  };
}

describe("RuleSetProvider", () => {
  it("compiles once and reuses the set while the version is unchanged", async () => {
    const fake = fakeRepository({ u1: { version: 2, rules: [allowRule()] } });
    const provider = new RuleSetProvider(fake.repository);
    const first = await provider.get("u1");
    const second = await provider.get("u1");
    expect(second).toBe(first);
    expect(first.version).toBe(2);
    expect(first.compiled?.collect.map((rule) => rule.id)).toEqual([RULE_ID]);
    expect(fake.calls).toEqual({ readVersion: 2, list: 1 });
  });

  it("rebuilds the set when the version moves, and a user with no rules has version 0", async () => {
    const fake = fakeRepository();
    const provider = new RuleSetProvider(fake.repository);
    expect(await provider.get("u1")).toMatchObject({ version: 0 });
    fake.set("u1", { version: 1, rules: [allowRule()] });
    const next = await provider.get("u1");
    expect(next.version).toBe(1);
    expect(next.compiled?.collect).toHaveLength(1);
    fake.set("u1", { version: 2, rules: [] });
    expect((await provider.get("u1")).compiled?.collect).toEqual([]);
    expect(fake.calls.list).toBe(3);
  });

  it("keeps users apart even at the same version", async () => {
    const other = "0192f1c2-7c1e-7a3b-9f00-00000000000b";
    const fake = fakeRepository({
      u1: { version: 1, rules: [allowRule()] },
      u2: { version: 1, rules: [allowRule(other)] },
    });
    const provider = new RuleSetProvider(fake.repository);
    expect((await provider.get("u1")).compiled?.collect[0]?.id).toBe(RULE_ID);
    expect((await provider.get("u2")).compiled?.collect[0]?.id).toBe(other);
    expect((await provider.get("u1")).compiled?.collect[0]?.id).toBe(RULE_ID);
  });

  it("caches under the version list() read, which can be newer than the one it checked", async () => {
    const fake = fakeRepository({ u1: { version: 5, rules: [allowRule()] } });
    let reads = 0;
    const stale = fake.repository.readVersion.bind(fake.repository);
    fake.repository.readVersion = async (userId: string) => {
      reads += 1;
      return reads === 1 ? 4 : stale(userId);
    };
    const provider = new RuleSetProvider(fake.repository);
    expect((await provider.get("u1")).version).toBe(5);
    await provider.get("u1");
    expect(fake.calls.list).toBe(1);
  });

  it("fails closed when a stored rule no longer fits the schema, and tries again next time", async () => {
    const fake = fakeRepository({ u1: { version: 1, rules: [allowRule()] } });
    fake.failListWith(new ZodError([]));
    const provider = new RuleSetProvider(fake.repository);
    expect(await provider.get("u1")).toEqual({ version: 1, compiled: null });
    fake.failListWith(undefined);
    expect((await provider.get("u1")).compiled).not.toBeNull();
  });

  it("does not hide a database failure: it propagates so the client retries", async () => {
    const fake = fakeRepository();
    fake.failListWith(new Error("connection lost"));
    const provider = new RuleSetProvider(fake.repository);
    await expect(provider.get("u1")).rejects.toThrow("connection lost");
  });

  it("compiles a set that does not validate into compiled: null, cached by its version", async () => {
    const twice = [allowRule(), allowRule()];
    const fake = fakeRepository({ u1: { version: 3, rules: twice } });
    const provider = new RuleSetProvider(fake.repository);
    expect(await provider.get("u1")).toEqual({ version: 3, compiled: null });
    await provider.get("u1");
    expect(fake.calls.list).toBe(1);
  });

  it("keeps at most RULE_SET_CACHE_MAX_USERS users, dropping the least recently loaded", async () => {
    const fake = fakeRepository();
    const provider = new RuleSetProvider(fake.repository);
    for (let i = 0; i <= RULE_SET_CACHE_MAX_USERS; i += 1) await provider.get(`user-${i}`);
    expect(fake.calls.list).toBe(RULE_SET_CACHE_MAX_USERS + 1);
    await provider.get(`user-${RULE_SET_CACHE_MAX_USERS}`);
    expect(fake.calls.list).toBe(RULE_SET_CACHE_MAX_USERS + 1);
    await provider.get("user-0");
    expect(fake.calls.list).toBe(RULE_SET_CACHE_MAX_USERS + 2);
  });

  it.each([undefined, null, "", "   "])("rejects a missing user scope (%j)", async (bad) => {
    const provider = new RuleSetProvider(fakeRepository().repository);
    await expect(provider.get(bad as unknown as string)).rejects.toBeInstanceOf(
      MissingUserScopeError,
    );
  });
});
