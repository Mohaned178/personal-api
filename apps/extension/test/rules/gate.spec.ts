// M4-06 layer one (the page gate) and layer two (the rule store) of capture.

import type { KnownEvent } from "@personal-api/contracts";
import { describe, expect, it } from "vitest";
import type { CaptureState, CaptureStore, CaptureTransition } from "../../lib/capture";
import { CONNECTION_STORAGE_KEY } from "../../lib/connect";
import {
  createRulesGate,
  mayCollect,
  mayCollectFocusSegment,
  probeEvents,
} from "../../lib/rules/gate";
import { createRuleStore } from "../../lib/rules/rule-store";
import { INTEGRATION_ID_2, pageEvent } from "../queue/support/world";
import {
  active,
  configOf,
  connectionFor,
  domainRule,
  memoryStorage,
  RULES_STORAGE_KEY,
  storedRules,
} from "./support";

const page = (domain: string, path = "/p") => ({ domain, path });

describe("probeEvents", () => {
  it("covers every event kind the engine emits about a page, with valid durations", () => {
    const types = probeEvents(page("github.com")).map((event) => event.type);
    expect(types).toContain("browser.page_visited");
    expect(types).toContain("browser.tab_opened");
    expect(types.filter((type) => type === "browser.focus_segment").length).toBeGreaterThan(1);
  });

  it("covers the page-less kinds when there is no page", () => {
    const types = probeEvents(null).map((event) => event.type);
    expect(types.sort()).toEqual([
      "browser.session_ended",
      "browser.session_started",
      "browser.tab_closed",
      "browser.tab_opened",
    ]);
  });
});

describe("mayCollect", () => {
  const rules = active(configOf([domainRule("GitHub", "github.com", "allow")]));

  it("allows a page a rule allows and denies any other (deny by default)", () => {
    expect(mayCollect(rules, page("github.com"))).toBe(true);
    expect(mayCollect(rules, page("other.example"))).toBe(false);
  });

  it("denies a page a drop rule drops, even with an allow-everything policy", () => {
    const dropping = active(
      configOf([domainRule("no", "bank.example", "drop")], { defaultPolicy: "allow" }),
    );
    expect(mayCollect(dropping, page("bank.example"))).toBe(false);
    expect(mayCollect(dropping, page("fine.example"))).toBe(true);
  });

  it("denies page-less events when no rule allows them, allows them under the allow policy", () => {
    expect(mayCollect(rules, null)).toBe(false);
    expect(mayCollect(active(configOf([], { version: 0, defaultPolicy: "allow" })), null)).toBe(
      true,
    );
  });

  it("allows a page whose rule only allows focus segments of some durations", () => {
    const longOnly = domainRule("long", "docs.example", "allow", {
      when: {
        type: ["browser.focus_segment"],
        all: [{ field: "data.durationMs", op: "gt", value: 5000 }],
      },
    });
    expect(mayCollect(active(configOf([longOnly])), page("docs.example"))).toBe(true);
  });

  it("mayCollectFocusSegment: only a rule that keeps focus segments counts, not one for visits", () => {
    const visits = domainRule("visits", "v.example", "allow", {
      when: {
        type: ["browser.page_visited"],
        all: [{ field: "data.domain", op: "eq", value: "v.example" }],
      },
    });
    const segments = domainRule("segments", "s.example", "allow", {
      when: {
        type: ["browser.focus_segment"],
        all: [{ field: "data.domain", op: "eq", value: "s.example" }],
      },
    });
    const rules = active(configOf([visits, segments]));
    expect(mayCollect(rules, page("v.example"))).toBe(true);
    expect(mayCollectFocusSegment(rules, page("v.example"))).toBe(false);
    expect(mayCollectFocusSegment(rules, page("s.example"))).toBe(true);
    expect(mayCollectFocusSegment(rules, page("other.example"))).toBe(false);
  });

  it("allows page-less events when a rule allows only session events", () => {
    const sessions = domainRule("sessions", "x", "allow", {
      when: { type: ["browser.session_*"] },
    });
    expect(mayCollect(active(configOf([sessions])), null)).toBe(true);
    expect(mayCollect(active(configOf([sessions])), page("github.com"))).toBe(false);
  });
});

describe("createRulesGate", () => {
  const config = configOf([domainRule("GitHub", "github.com", "allow")]);
  const paired = (extra: Record<string, unknown> = {}) =>
    memoryStorage({
      [CONNECTION_STORAGE_KEY]: connectionFor(),
      [RULES_STORAGE_KEY]: storedRules(config),
      ...extra,
    });

  it("allows an allowed page and denies the rest", async () => {
    const gate = createRulesGate(paired());
    expect(await gate.allows(page("github.com"))).toBe(true);
    expect(await gate.allows(page("other.example"))).toBe(false);
    expect(await gate.allows(null)).toBe(false);
  });

  it("reads fresh on every call: a removed rule or connection applies at once", async () => {
    const storage = paired();
    const gate = createRulesGate(storage);
    expect(await gate.allows(page("github.com"))).toBe(true);
    await storage.remove(RULES_STORAGE_KEY);
    expect(await gate.allows(page("github.com"))).toBe(false);
    await storage.set({ [RULES_STORAGE_KEY]: storedRules(config) });
    expect(await gate.allows(page("github.com"))).toBe(true);
    await storage.remove(CONNECTION_STORAGE_KEY);
    expect(await gate.allows(page("github.com"))).toBe(false);
  });

  it.each([
    ["no rules stored", { [RULES_STORAGE_KEY]: undefined }],
    ["rules that do not validate", { [RULES_STORAGE_KEY]: { owner: 1 } }],
    [
      "rules of another integration",
      {
        [RULES_STORAGE_KEY]: storedRules(config, {
          connection: connectionFor(undefined, { integrationId: INTEGRATION_ID_2 }),
        }),
      },
    ],
  ])("denies with %s", async (_label, override) => {
    expect(await createRulesGate(paired(override)).allows(page("github.com"))).toBe(false);
  });

  it("denies when the read fails", async () => {
    const gate = createRulesGate({
      get: async () => {
        throw new Error("storage unavailable");
      },
    });
    expect(await gate.allows(page("github.com"))).toBe(false);
  });
});

describe("createRuleStore", () => {
  /** A store that records what is committed. `compute` runs on a fixed previous state. */
  function recordingStore() {
    const committed: { state: CaptureState; events: unknown[] }[] = [];
    let computeCalls = 0;
    const store: CaptureStore = {
      async transact(compute) {
        computeCalls += 1;
        committed.push(compute({ v: 1 }));
      },
    };
    return { store, committed, computeCalls: () => computeCalls };
  }
  const transition = (events: KnownEvent[]): CaptureTransition => ({ state: { v: 2 }, events });
  const rules = active(configOf([domainRule("GitHub", "github.com", "allow")], { version: 4 }));

  it("queues only allowed events, stamped with the version, and still moves the state", async () => {
    const { store, committed } = recordingStore();
    const ruleStore = createRuleStore({ store, loadRules: async () => rules });
    await ruleStore.transact(() =>
      transition([
        pageEvent(1, { domain: "github.com" }) as KnownEvent,
        pageEvent(2, { domain: "other.example" }) as KnownEvent,
      ]),
    );
    expect(committed).toHaveLength(1);
    expect(committed[0]?.state).toEqual({ v: 2 });
    const events = committed[0]?.events as KnownEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]?.meta?.ruleSetVersion).toBe(4);
  });

  it("queues nothing when the rules are missing, but the state still moves (fail closed)", async () => {
    const { store, committed } = recordingStore();
    const ruleStore = createRuleStore({ store, loadRules: async () => null });
    await ruleStore.transact(() => transition([pageEvent(1) as KnownEvent]));
    expect(committed[0]).toEqual({ state: { v: 2 }, events: [] });
  });

  it("queues nothing when loading the rules fails", async () => {
    const { store, committed } = recordingStore();
    const ruleStore = createRuleStore({
      store,
      loadRules: async () => {
        throw new Error("storage unavailable");
      },
    });
    await ruleStore.transact(() => transition([pageEvent(1) as KnownEvent]));
    expect(committed[0]?.events).toEqual([]);
  });

  it("calls compute exactly once, with the store's previous state", async () => {
    const { store } = recordingStore();
    const seen: unknown[] = [];
    const ruleStore = createRuleStore({ store, loadRules: async () => rules });
    await ruleStore.transact((prev) => {
      seen.push(prev);
      return transition([]);
    });
    expect(seen).toEqual([{ v: 1 }]);
  });

  it("rejects when the underlying commit fails (the engine settles it)", async () => {
    const failing: CaptureStore = {
      transact: async () => {
        throw new Error("commit failed");
      },
    };
    const ruleStore = createRuleStore({ store: failing, loadRules: async () => rules });
    await expect(ruleStore.transact(() => transition([]))).rejects.toThrow("commit failed");
  });
});
