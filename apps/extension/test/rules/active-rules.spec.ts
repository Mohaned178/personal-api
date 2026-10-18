// M4-06 stored rules: when they apply, and what they do to events.

import { type KnownEvent, parseEvent } from "@personal-api/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CONNECTION_STORAGE_KEY } from "../../lib/connect";
import {
  activeRules,
  applyRules,
  EVENT_CLIENT,
  readActiveRules,
} from "../../lib/rules/active-rules";
import { INTEGRATION_ID_2, ORIGIN_2, pageEvent } from "../queue/support/world";
import {
  active,
  configOf,
  connectionFor,
  domainRule,
  memoryStorage,
  RULES_STORAGE_KEY,
  storedRules,
} from "./support";

const visit = (domain: string, path = "/a/b"): KnownEvent =>
  pageEvent(1, { domain, path }) as KnownEvent;

describe("activeRules: only valid rules of this connection run", () => {
  const config = configOf([domainRule("GitHub", "github.com", "allow")]);

  it("returns the compiled rules for a stored set of the same owner", () => {
    const rules = activeRules(storedRules(config), connectionFor());
    expect(rules?.version).toBe(1);
    expect(rules?.defaultPolicy).toBe("deny");
    expect(rules?.ruleSet.collect).toHaveLength(1);
  });

  it.each([
    ["nothing stored", undefined],
    ["null", null],
    ["a string", "rules"],
    ["an array", []],
    ["no owner", { etag: '"x"', config }],
    ["no config", { owner: storedRules(config).owner, etag: '"x"' }],
    ["a non-string etag", { ...storedRules(config), etag: 1 }],
    ["a config with an unknown key", { ...storedRules(config), config: { ...config, extra: 1 } }],
    [
      "a config with a negative version",
      { ...storedRules(config), config: { ...config, ruleSetVersion: -1 } },
    ],
    [
      "a rule the contract refuses",
      { ...storedRules(config), config: { ...config, rules: [{ ...config.rules[0], then: [] }] } },
    ],
    [
      "a process-stage rule",
      {
        ...storedRules(config),
        config: {
          ...config,
          rules: [{ ...config.rules[0], stage: "process", then: [{ action: "tag", tag: "x" }] }],
        },
      },
    ],
  ])("is null for %s (fail closed)", (_label, stored) => {
    expect(activeRules(stored, connectionFor())).toBeNull();
  });

  it("is null without a connection", () => {
    expect(activeRules(storedRules(config), null)).toBeNull();
  });

  it("is null for rules fetched for another server or another integration", () => {
    const stored = storedRules(config);
    expect(activeRules(stored, connectionFor(undefined, { serverOrigin: ORIGIN_2 }))).toBeNull();
    expect(
      activeRules(stored, connectionFor(undefined, { integrationId: INTEGRATION_ID_2 })),
    ).toBeNull();
  });

  it("is null when a stored getter throws (never rejects or throws)", () => {
    const poisoned = {
      owner: storedRules(config).owner,
      get etag(): string {
        throw new Error("boom");
      },
      config,
    };
    expect(activeRules(poisoned, connectionFor())).toBeNull();
  });
});

describe("readActiveRules", () => {
  const config = configOf([domainRule("GitHub", "github.com", "allow")]);

  it("reads the connection and the rules in ONE storage call", async () => {
    const storage = memoryStorage({
      [CONNECTION_STORAGE_KEY]: connectionFor(),
      [RULES_STORAGE_KEY]: storedRules(config),
    });
    const calls: unknown[] = [];
    const rules = await readActiveRules({
      get: (keys) => {
        calls.push(keys);
        return storage.get(keys);
      },
    });
    expect(rules?.version).toBe(1);
    expect(calls).toEqual([[CONNECTION_STORAGE_KEY, RULES_STORAGE_KEY]]);
  });

  it("is null when there is no connection, or when the read fails", async () => {
    const noConnection = memoryStorage({ [RULES_STORAGE_KEY]: storedRules(config) });
    expect(await readActiveRules(noConnection)).toBeNull();
    expect(
      await readActiveRules({
        get: async () => {
          throw new Error("storage unavailable");
        },
      }),
    ).toBeNull();
  });
});

describe("applyRules", () => {
  it("keeps an allowed event and stamps the rule-set version and the client", () => {
    const rules = active(configOf([domainRule("GitHub", "github.com", "allow")], { version: 7 }));
    const [kept] = applyRules(rules, [visit("github.com")]);
    expect(kept?.meta).toEqual({ ruleSetVersion: 7, client: EVENT_CLIENT });
    expect(EVENT_CLIENT).toMatch(/^pa-extension\/\d+\.\d+\.\d+$/);
  });

  it("removes an event no rule decides under the deny policy", () => {
    const rules = active(configOf([domainRule("GitHub", "github.com", "allow")]));
    expect(applyRules(rules, [visit("other.example")])).toEqual([]);
  });

  it("keeps an event no rule decides under the allow policy, stamped", () => {
    const rules = active(configOf([], { version: 0, defaultPolicy: "allow" }));
    const [kept] = applyRules(rules, [visit("anything.example")]);
    expect(kept?.meta?.ruleSetVersion).toBe(0);
  });

  it("removes every event under deny with no rules", () => {
    const rules = active(configOf([], { version: 0 }));
    expect(applyRules(rules, [visit("github.com"), visit("other.example")])).toEqual([]);
  });

  it("lets a drop rule beat an allow rule at the same priority", () => {
    const rules = active(
      configOf([
        domainRule("allow", "github.com", "allow"),
        domainRule("drop", "github.com", "drop"),
      ]),
    );
    expect(applyRules(rules, [visit("github.com")])).toEqual([]);
  });

  it("applies coarsen and redact to what is queued", () => {
    const coarsen = domainRule("Coarse", "github.com", "allow", {
      then: [{ action: "allow" }, { action: "coarsen", segments: 1 }],
    });
    const rules = active(configOf([coarsen]));
    const [kept] = applyRules(rules, [visit("github.com", "/org/repo/issues/1")]);
    expect(kept?.type).toBe("browser.page_visited");
    expect((kept?.data as { path: string } | undefined)?.path).toBe("/org");
  });

  it("keeps the order of the events it keeps", () => {
    const rules = active(configOf([domainRule("GitHub", "github.com", "allow")]));
    const events = [visit("github.com", "/1"), visit("other.example"), visit("github.com", "/2")];
    const kept = applyRules(rules, events).map((e) => (e.data as { path: string }).path);
    expect(kept).toEqual(["/1", "/2"]);
  });

  it("does not change the events it is given", () => {
    const rules = active(configOf([domainRule("GitHub", "github.com", "allow")]));
    const event = visit("github.com");
    const copy = structuredClone(event);
    applyRules(rules, [event]);
    expect(event).toEqual(copy);
  });

  it("removes an event the engine cannot read (fail closed), without throwing", () => {
    const rules = active(configOf([], { version: 0, defaultPolicy: "allow" }));
    const broken = { ...visit("github.com"), data: { domain: 5 } } as unknown as KnownEvent;
    expect(applyRules(rules, [broken])).toEqual([]);
  });

  it("only ever produces events the contract accepts (property)", () => {
    const rules = active(
      configOf([
        domainRule("Coarse", "github.com", "allow", {
          then: [{ action: "allow" }, { action: "coarsen", segments: 1 }],
        }),
      ]),
    );
    fc.assert(
      fc.property(
        fc.constantFrom("github.com", "other.example", "a.b.example"),
        fc.array(fc.constantFrom("a", "b", "c"), { maxLength: 5 }),
        (domain, segments) => {
          const path = `/${segments.join("/")}`;
          for (const kept of applyRules(rules, [visit(domain, path)])) {
            expect(parseEvent(kept).ok).toBe(true);
          }
        },
      ),
    );
  });

  it("never keeps a domain that a rule drops or that no rule allows (property)", () => {
    const rules = active(
      configOf([
        domainRule("allow gh", "github.com", "allow"),
        domainRule("drop gh", "github.com", "drop", { priority: 5 }),
        domainRule("allow ex", "example.com", "allow"),
      ]),
    );
    fc.assert(
      fc.property(
        fc.constantFrom("github.com", "example.com", "other.example", "evil.github.com"),
        (domain) => {
          const kept = applyRules(rules, [visit(domain)]);
          if (domain === "example.com") expect(kept).toHaveLength(1);
          else expect(kept).toEqual([]);
        },
      ),
    );
  });
});
