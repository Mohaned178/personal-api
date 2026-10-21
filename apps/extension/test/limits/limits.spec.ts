// M9-02 daily site limits on the device. Local wall-clock times, so the tests hold in any time zone.

import type { Limit } from "@personal-api/contracts";
import { describe, expect, it } from "vitest";
import type { CaptureStore } from "../../lib/capture";
import { CONNECTION_STORAGE_KEY } from "../../lib/connect";
import {
  blockingLimit,
  limitStatuses,
  planNotices,
  SNOOZE_MS,
  WARNING_LEFT_MS,
} from "../../lib/limits/evaluate";
import { localDayStart, readOpenUse } from "../../lib/limits/open";
import {
  createLimitsService,
  LIMIT_BADGE_COLOR,
  type LimitTab,
  readLimitStatuses,
  snoozeLimit,
} from "../../lib/limits/service";
import {
  LIMITS_NOTIFIED_STORAGE_KEY,
  LIMITS_SNOOZE_STORAGE_KEY,
  readExtra,
} from "../../lib/limits/state";
import { activeLimits } from "../../lib/rules/active-rules";
import { createRuleStore } from "../../lib/rules/rule-store";
import {
  createTodayCounter,
  createTodayStore,
  localDate,
  TODAY_STORAGE_KEY,
} from "../../lib/today";
import { advance, newSim, SECOND, setupSimTests } from "../capture/support/sim";
import {
  active,
  configOf,
  connectionFor,
  domainRule,
  KEY,
  memoryStorage,
  RULES_STORAGE_KEY,
  storedRules,
} from "../rules/support";

setupSimTests();

const MIN = 60_000;
const at = (day: number, hour: number, minute = 0, second = 0) =>
  new Date(2026, 9, day, hour, minute, second).getTime();

let counter = 0;
function limit(pattern: string, minutes: number, strict = false): Limit {
  counter += 1;
  return {
    id: `0192f1c2-7c1e-7a3b-9f00-${String(counter).padStart(12, "0")}`,
    pattern,
    minutes,
    strict,
  };
}

const TIME_UP = (id: string) => `moz-extension://abc/time-up.html?l=${id}`;

/** One device: storage, a clock, the open segment, a tab list and spies for everything shown. */
function device(limits: Limit[], options: { start?: number; tabs?: LimitTab[] } = {}) {
  let clock = options.start ?? at(15, 12);
  const config = configOf([domainRule("Allow", "a.test", "allow")], { limits });
  const storage = memoryStorage({
    [CONNECTION_STORAGE_KEY]: connectionFor(),
    [RULES_STORAGE_KEY]: storedRules(config),
  });
  const world = {
    now: () => clock,
    set clock(value: number) {
      clock = value;
    },
    storage,
    open: null as { domain: string; ms: number } | null,
    tabs: options.tabs ?? ([] as LimitTab[]),
    notices: [] as { id: string; title: string; message: string }[],
    badge: { text: "", color: "" },
    redirects: [] as { tabId: number; url: string }[],
    /** Adds committed time on a site today, like the Today counter does. */
    addTime(domain: string, ms: number) {
      const stored = storage.stored[TODAY_STORAGE_KEY] as {
        date: string;
        ms: Record<string, number>;
      };
      const base = stored?.date === localDate(clock) ? stored.ms : {};
      storage.stored[TODAY_STORAGE_KEY] = {
        date: localDate(clock),
        ms: { ...base, [domain]: (base[domain] ?? 0) + ms },
      };
    },
    service() {
      return createLimitsService({
        storage,
        now: world.now,
        readOpen: async () => world.open,
        notifications: {
          create: (id, o) => {
            world.notices.push({ id, title: o.title, message: o.message });
          },
        },
        action: {
          setBadgeText: ({ text }) => {
            world.badge.text = text;
          },
          setBadgeBackgroundColor: ({ color }) => {
            world.badge.color = color;
          },
        },
        tabs: {
          query: async () => world.tabs.map((tab) => ({ ...tab })),
          update: async (tabId, { url }) => {
            world.redirects.push({ tabId, url });
          },
        },
        alarms: { get: async () => undefined, create: () => undefined },
        timeUpUrl: TIME_UP,
        iconUrl: "icon.png",
      });
    },
  };
  return world;
}

const tab = (id: number, url: string, incognito = false): LimitTab => ({ id, url, incognito });

describe("limit status", () => {
  const yt = limit("youtube.com", 30);
  const wild = limit("*.reddit.com", 10);

  it("sums the time of every site a pattern matches, and the open segment", () => {
    const statuses = limitStatuses(
      [yt, wild],
      {
        "youtube.com": 5 * MIN,
        "www.youtube.com": 9 * MIN,
        "reddit.com": 2 * MIN,
        "old.reddit.com": 3 * MIN,
        "x.test": 99 * MIN,
      },
      { domain: "old.reddit.com", ms: MIN },
      {},
    );
    // `youtube.com` is exact: the www subdomain is a different site. `*.reddit.com` has no apex.
    expect(statuses[0]).toMatchObject({ usedMs: 5 * MIN, leftMs: 25 * MIN, reached: false });
    expect(statuses[1]).toMatchObject({ usedMs: 4 * MIN, leftMs: 6 * MIN, reached: false });
  });

  it("is reached at exactly the allowance, and time added by 5 more minutes moves it", () => {
    const [atLimit] = limitStatuses([yt], { "youtube.com": 30 * MIN }, null, {});
    expect(atLimit).toMatchObject({ reached: true, leftMs: 0 });
    const [snoozed] = limitStatuses([yt], { "youtube.com": 30 * MIN }, null, {
      [yt.id]: SNOOZE_MS,
    });
    expect(snoozed).toMatchObject({ allowedMs: 35 * MIN, leftMs: 5 * MIN, reached: false });
  });

  it("picks the first used-up limit that covers a domain", () => {
    const statuses = limitStatuses(
      [yt, limit("*.youtube.com", 1)],
      { "m.youtube.com": 2 * MIN },
      null,
      {},
    );
    expect(blockingLimit(statuses, "m.youtube.com")?.pattern).toBe("*.youtube.com");
    expect(blockingLimit(statuses, "youtube.com")).toBeNull();
    expect(blockingLimit(statuses, "other.test")).toBeNull();
  });
});

describe("notices", () => {
  const long = limit("youtube.com", 60);
  const short = limit("short.test", 8);

  const plan = (used: number, notified = {}, target = long) =>
    planNotices(limitStatuses([target], { [target.pattern]: used }, null, {}), notified);

  it("warns once with 10 minutes left", () => {
    expect(plan(49 * MIN).notices).toEqual([]);
    const first = plan(50 * MIN);
    expect(first.notices.map((n) => n.kind)).toEqual(["warning"]);
    expect(plan(55 * MIN, first.next).notices).toEqual([]);
  });

  it("does not warn for a limit of 10 minutes or less", () => {
    expect(WARNING_LEFT_MS).toBe(10 * MIN);
    expect(plan(0, {}, short).notices).toEqual([]);
    expect(plan(5 * MIN, {}, short).notices).toEqual([]);
    expect(plan(8 * MIN, {}, short).notices.map((n) => n.kind)).toEqual(["reached"]);
  });

  it("says only that the limit is reached when it is first seen over the limit", () => {
    expect(plan(75 * MIN).notices.map((n) => n.kind)).toEqual(["reached"]);
  });

  it("notifies the limit once, and again for each used-up 5 more minutes", () => {
    const first = plan(60 * MIN);
    expect(first.notices.map((n) => n.kind)).toEqual(["reached"]);
    expect(plan(61 * MIN, first.next).notices).toEqual([]);
    const snoozed = limitStatuses([long], { [long.pattern]: 65 * MIN }, null, {
      [long.id]: SNOOZE_MS,
    });
    const second = planNotices(snoozed, first.next);
    expect(second.notices.map((n) => [n.kind, n.allowedMs])).toEqual([["reached", 65 * MIN]]);
    expect(planNotices(snoozed, second.next).notices).toEqual([]);
  });
});

describe("the limits service", () => {
  it("warns with 10 minutes left, then reaches the limit, in the order the time passes", async () => {
    const yt = limit("youtube.com", 30);
    const d = device([yt]);
    const service = d.service();
    await service.tick();
    expect(d.notices).toEqual([]);
    expect(d.badge.text).toBe("");

    d.addTime("youtube.com", 20 * MIN);
    await service.tick();
    expect(d.notices.map((n) => n.message)).toEqual(["10 minutes left on youtube.com"]);

    d.addTime("youtube.com", 10 * MIN);
    await service.tick();
    expect(d.notices.map((n) => n.message)).toEqual([
      "10 minutes left on youtube.com",
      "Time's up for youtube.com",
    ]);
    expect(d.badge).toEqual({ text: "!", color: LIMIT_BADGE_COLOR });

    // Nothing repeats on the next ticks.
    await service.tick();
    await service.tick();
    expect(d.notices).toHaveLength(2);
  });

  it("counts the segment still open, not only the closed ones", async () => {
    const d = device([limit("youtube.com", 30)]);
    d.addTime("youtube.com", 10 * MIN);
    d.open = { domain: "youtube.com", ms: 20 * MIN };
    await d.service().tick();
    expect(d.notices.map((n) => n.message)).toContain("Time's up for youtube.com");
  });

  it("shows nothing but the pattern the limit was set on", async () => {
    const d = device([limit("*.example.com", 11)]);
    d.addTime("secret-sub.example.com", 12 * MIN);
    d.tabs = [tab(1, "https://secret-sub.example.com/private/page?token=s3cr3t#frag")];
    await d.service().tick();
    expect(d.notices.map((n) => n.message)).toEqual(["Time's up for *.example.com"]);
    const everything = JSON.stringify([d.notices, d.badge]);
    expect(everything).not.toContain("secret-sub");
    expect(everything).not.toContain("private");
    expect(everything).not.toContain("s3cr3t");
  });

  it("moves the tabs on a used-up site to the Time's up page, and no other tab", async () => {
    const yt = limit("youtube.com", 5);
    const d = device([yt], {
      tabs: [
        tab(1, "https://youtube.com/watch?v=abc"),
        tab(2, "https://www.youtube.com/watch"),
        tab(3, "https://other.test/"),
        tab(4, "https://youtube.com/private-window", true),
        tab(5, "about:addons"),
        { url: "https://youtube.com/no-id" },
      ],
    });
    d.addTime("youtube.com", 5 * MIN);
    await d.service().tick();
    // `www.youtube.com` is not covered by the exact pattern `youtube.com`.
    expect(d.redirects).toEqual([{ tabId: 1, url: TIME_UP(yt.id) }]);
  });

  it("does not move a tab while the time is not used up", async () => {
    const d = device([limit("youtube.com", 30)], { tabs: [tab(1, "https://youtube.com/")] });
    d.addTime("youtube.com", 29 * MIN);
    await d.service().tick();
    expect(d.redirects).toEqual([]);
  });

  it("blocks a site opened after the limit was reached", async () => {
    const yt = limit("youtube.com", 5);
    const d = device([yt]);
    d.addTime("youtube.com", 6 * MIN);
    const service = d.service();
    await service.tick();
    expect(d.redirects).toEqual([]);
    d.tabs = [tab(7, "https://youtube.com/new")];
    await service.tick();
    expect(d.redirects).toEqual([{ tabId: 7, url: TIME_UP(yt.id) }]);
  });

  it("gives 5 more minutes, then notifies and blocks again when they are used up", async () => {
    const yt = limit("youtube.com", 5);
    const d = device([yt], { tabs: [tab(1, "https://youtube.com/")] });
    const service = d.service();
    d.addTime("youtube.com", 5 * MIN);
    await service.tick();
    expect(d.redirects).toHaveLength(1);

    expect(await snoozeLimit({ storage: d.storage, now: d.now }, yt.id)).toBe("snoozed");
    await service.tick();
    expect(d.redirects).toHaveLength(1);
    expect(d.badge.text).toBe("");

    d.addTime("youtube.com", 4 * MIN);
    await service.tick();
    expect(d.redirects).toHaveLength(1);
    expect(d.notices).toHaveLength(1);

    d.addTime("youtube.com", 1 * MIN);
    await service.tick();
    expect(d.redirects).toHaveLength(2);
    expect(d.notices.map((n) => n.message)).toEqual([
      "Time's up for youtube.com",
      "Time's up for youtube.com",
    ]);
    expect(d.badge.text).toBe("!");

    // Each "5 more minutes" adds another 5.
    expect(await snoozeLimit({ storage: d.storage, now: d.now }, yt.id)).toBe("snoozed");
    expect(readExtra(d.storage.stored[LIMITS_SNOOZE_STORAGE_KEY], d.now())[yt.id]).toBe(
      2 * SNOOZE_MS,
    );
  });

  it("refuses 5 more minutes in strict mode and keeps blocking until local midnight", async () => {
    const yt = limit("youtube.com", 5, true);
    const d = device([yt], { tabs: [tab(1, "https://youtube.com/")] });
    d.addTime("youtube.com", 6 * MIN);
    const service = d.service();
    await service.tick();
    expect(await snoozeLimit({ storage: d.storage, now: d.now }, yt.id)).toBe("strict");
    expect(d.storage.stored).not.toHaveProperty(LIMITS_SNOOZE_STORAGE_KEY);

    d.clock = at(15, 23, 59);
    d.addTime("youtube.com", 1);
    await service.tick();
    expect(d.redirects.length).toBeGreaterThanOrEqual(2);
    expect(d.badge.text).toBe("!");

    // Local midnight: a new day's totals start empty, and the block is lifted.
    d.clock = at(16, 0, 0, 5);
    d.redirects.length = 0;
    await service.tick();
    expect(d.redirects).toEqual([]);
    expect(d.badge.text).toBe("");
  });

  it("refuses 5 more minutes for a limit that is not in the active config", async () => {
    const d = device([limit("youtube.com", 5)]);
    expect(
      await snoozeLimit({ storage: d.storage, now: d.now }, "0192f1c2-7c1e-7a3b-9f00-0000000000ff"),
    ).toBe("unknown");
    expect(d.storage.stored).not.toHaveProperty(LIMITS_SNOOZE_STORAGE_KEY);
  });

  it("resets at local midnight: snooze, notices and usage start over", async () => {
    const yt = limit("youtube.com", 20);
    const d = device([yt]);
    const service = d.service();
    d.addTime("youtube.com", 21 * MIN);
    await service.tick();
    await snoozeLimit({ storage: d.storage, now: d.now }, yt.id);
    expect(d.notices.map((n) => n.message)).toEqual(["Time's up for youtube.com"]);

    d.clock = at(16, 0, 1);
    await service.tick();
    const [status] = await readLimitStatuses({
      storage: d.storage,
      now: d.now,
      readOpen: async () => null,
    });
    expect(status).toMatchObject({ usedMs: 0, allowedMs: 20 * MIN, reached: false });
    expect(d.badge.text).toBe("");

    // The next day reaches the limit again and is told again.
    d.addTime("youtube.com", 10 * MIN);
    await service.tick();
    d.addTime("youtube.com", 10 * MIN);
    await service.tick();
    expect(d.notices.map((n) => n.message)).toEqual([
      "Time's up for youtube.com",
      "10 minutes left on youtube.com",
      "Time's up for youtube.com",
    ]);
  });

  it("keeps its state across a background restart mid-day", async () => {
    const yt = limit("youtube.com", 30);
    const d = device([yt], { tabs: [tab(1, "https://youtube.com/")] });
    d.addTime("youtube.com", 21 * MIN);
    await d.service().tick();
    expect(d.notices.map((n) => n.message)).toEqual(["10 minutes left on youtube.com"]);

    // The background was killed: a new service over the same storage. Nothing is repeated.
    const restarted = d.service();
    await restarted.start();
    await restarted.tick();
    expect(d.notices).toHaveLength(1);

    d.clock = at(15, 12, 3);
    d.addTime("youtube.com", 9 * MIN);
    await restarted.tick();
    expect(d.notices.map((n) => n.message)).toEqual([
      "10 minutes left on youtube.com",
      "Time's up for youtube.com",
    ]);
    expect(d.redirects).toEqual([{ tabId: 1, url: TIME_UP(yt.id) }]);

    // And a second restart keeps the snooze it was given.
    await snoozeLimit({ storage: d.storage, now: d.now }, yt.id);
    const again = d.service();
    d.redirects.length = 0;
    await again.start();
    expect(d.redirects).toEqual([]);
  });

  it("creates its periodic alarm once", async () => {
    const created: string[] = [];
    const d = device([limit("youtube.com", 5)]);
    let exists = false;
    const real = createLimitsService({
      storage: d.storage,
      now: d.now,
      readOpen: async () => null,
      notifications: { create: () => undefined },
      action: { setBadgeText: () => undefined, setBadgeBackgroundColor: () => undefined },
      tabs: { query: async () => [], update: async () => undefined },
      alarms: {
        get: async () => (exists ? { name: "pa-limits" } : undefined),
        create: (name, info) => {
          created.push(`${name}:${info.periodInMinutes}`);
          exists = true;
        },
      },
      timeUpUrl: TIME_UP,
      iconUrl: "icon.png",
    });
    await real.start();
    await real.start();
    expect(created).toEqual(["pa-limits:0.5"]);
    expect(real.onAlarm({ name: "other" })).toBeUndefined();
    expect(real.onAlarm({ name: "pa-limits" })).toBeInstanceOf(Promise);
  });
});

describe("what is enforced", () => {
  const yt = limit("youtube.com", 5);

  it("enforces nothing without a valid connection and rules (fail closed)", async () => {
    const d = device([yt], { tabs: [tab(1, "https://youtube.com/")] });
    d.addTime("youtube.com", 10 * MIN);
    for (const broken of [
      { [CONNECTION_STORAGE_KEY]: undefined },
      { [RULES_STORAGE_KEY]: undefined },
      { [RULES_STORAGE_KEY]: { not: "rules" } },
      {
        [CONNECTION_STORAGE_KEY]: connectionFor(KEY, {
          integrationId: "0192f1c2-7c1e-7a3b-9f00-0000000000aa",
        }),
      },
    ]) {
      const e = device([yt], { tabs: [tab(1, "https://youtube.com/")] });
      e.addTime("youtube.com", 10 * MIN);
      Object.assign(e.storage.stored, broken);
      await e.service().tick();
      expect(e.redirects, JSON.stringify(Object.keys(broken))).toEqual([]);
      expect(e.notices).toEqual([]);
    }
    await d.service().tick();
    expect(d.redirects).toHaveLength(1);
  });

  it("reads the limits from the rules config only when the rules are valid", () => {
    const config = configOf([domainRule("Allow", "a.test", "allow")], { limits: [yt] });
    expect(activeLimits(storedRules(config), connectionFor())).toEqual([yt]);
    expect(activeLimits(storedRules(config), null)).toEqual([]);
    expect(activeLimits(undefined, connectionFor())).toEqual([]);
    // A config stored before limits existed is still valid and has none.
    const { limits: _limits, ...old } = config;
    expect(activeLimits({ ...storedRules(config), config: old }, connectionFor())).toEqual([]);
  });

  it("never rejects, even when storage and the browser fail", async () => {
    const d = device([yt]);
    const failing = createLimitsService({
      storage: {
        get: () => Promise.reject(new Error("boom")),
        set: () => Promise.reject(new Error("boom")),
      },
      now: d.now,
      readOpen: () => Promise.reject(new Error("boom")),
      notifications: { create: () => Promise.reject(new Error("boom")) },
      action: {
        setBadgeText: () => Promise.reject(new Error("boom")),
        setBadgeBackgroundColor: () => Promise.reject(new Error("boom")),
      },
      tabs: {
        query: () => Promise.reject(new Error("boom")),
        update: () => Promise.reject(new Error("boom")),
      },
      alarms: {
        get: () => Promise.reject(new Error("boom")),
        create: () => Promise.reject(new Error("boom")),
      },
      timeUpUrl: TIME_UP,
      iconUrl: "icon.png",
    });
    await expect(failing.tick()).resolves.toBeUndefined();
    await expect(failing.start()).resolves.toBeUndefined();
    const brokenStorage = {
      get: () => Promise.reject(new Error("boom")),
      set: () => Promise.reject(new Error("boom")),
    };
    expect(await snoozeLimit({ storage: brokenStorage, now: d.now }, yt.id)).toBe("unknown");

    // Notifications that fail do not stop the badge or the redirect.
    const e = device([yt], { tabs: [tab(1, "https://youtube.com/")] });
    e.addTime("youtube.com", 6 * MIN);
    const partly = createLimitsService({
      storage: e.storage,
      now: e.now,
      readOpen: async () => null,
      notifications: { create: () => Promise.reject(new Error("boom")) },
      action: { setBadgeText: () => undefined, setBadgeBackgroundColor: () => undefined },
      tabs: {
        query: async () => e.tabs,
        update: async (tabId, { url }) => void e.redirects.push({ tabId, url }),
      },
      alarms: { get: async () => undefined, create: () => undefined },
      timeUpUrl: TIME_UP,
      iconUrl: "icon.png",
    });
    await partly.tick();
    expect(e.redirects).toHaveLength(1);
  });

  it("stores no page, path, query or domain visited: only ids, numbers and the date", async () => {
    const yt2 = limit("youtube.com", 5);
    const d = device([yt2], {
      tabs: [tab(1, "https://youtube.com/watch/secret-path?v=s3cr3t#frag")],
    });
    d.addTime("youtube.com", 6 * MIN);
    await d.service().tick();
    await snoozeLimit({ storage: d.storage, now: d.now }, yt2.id);
    const written = JSON.stringify([
      d.storage.stored[LIMITS_NOTIFIED_STORAGE_KEY],
      d.storage.stored[LIMITS_SNOOZE_STORAGE_KEY],
      d.redirects,
    ]);
    for (const secret of ["secret-path", "s3cr3t", "frag", "watch", "youtube"]) {
      expect(written).not.toContain(secret);
    }
  });
});

describe("what counts toward a limit", () => {
  const allowed = domainRule("Allow a", "a.test", "allow");
  const dropped = domainRule("Drop b", "b.test", "drop", { priority: 1 });
  const rules = active(configOf([allowed, dropped]));

  const wrapWith =
    (storage: ReturnType<typeof memoryStorage>) =>
    (store: CaptureStore): CaptureStore =>
      createRuleStore({
        store: createTodayStore({ store, counter: createTodayCounter({ storage, now: Date.now }) }),
        loadRules: async () => rules,
      });

  const statusesOf = (
    sim: ReturnType<typeof newSim>,
    storage: ReturnType<typeof memoryStorage>,
    limits: Limit[],
  ) => {
    storage.stored[CONNECTION_STORAGE_KEY] = connectionFor();
    storage.stored[RULES_STORAGE_KEY] = storedRules(configOf([allowed, dropped], { limits }));
    return readLimitStatuses({
      storage,
      now: Date.now,
      readOpen: () => readOpenUse(sim.store, Date.now()),
    });
  };

  it("counts an allowed site, including the segment still open", async () => {
    const storage = memoryStorage();
    const sim = newSim({ wrapStore: wrapWith(storage) });
    const la = limit("a.test", 30);
    await sim.start();
    await sim.navigate(sim.tabId, "https://a.test/home");
    advance(40 * SECOND);
    // Still on the page: nothing is committed yet, but the open segment counts.
    expect((await statusesOf(sim, storage, [la]))[0]?.usedMs).toBe(40_000);
    await sim.blur();
    expect((await statusesOf(sim, storage, [la]))[0]?.usedMs).toBe(40_000);
  });

  it("never counts a site the rules drop, or a private window", async () => {
    const storage = memoryStorage();
    const sim = newSim({ wrapStore: wrapWith(storage) });
    const lb = limit("b.test", 1);
    const la = limit("a.test", 30);
    await sim.start();
    await sim.navigate(sim.tabId, "https://b.test/bank");
    advance(5 * 60 * SECOND);
    expect((await statusesOf(sim, storage, [lb, la]))[0]).toMatchObject({
      usedMs: 0,
      reached: false,
    });
    const incognito = await sim.openWindow({ incognito: true });
    await sim.navigate(incognito.tabId, "https://a.test/private");
    advance(5 * 60 * SECOND);
    await sim.closeTab(incognito.tabId);
    await sim.blur();
    const statuses = await statusesOf(sim, storage, [lb, la]);
    expect(statuses.map((s) => [s.pattern, s.usedMs, s.reached])).toEqual([
      ["b.test", 0, false],
      ["a.test", 0, false],
    ]);
  });

  it("stops counting an open segment that was last seen alive long ago", async () => {
    const storage = memoryStorage();
    const sim = newSim({ wrapStore: wrapWith(storage) });
    const la = limit("a.test", 30);
    await sim.start();
    await sim.navigate(sim.tabId, "https://a.test/home");
    advance(30 * SECOND);
    await sim.engine.onHeartbeat();
    // The machine slept for an hour: no focus step ran, so the segment counts up to the last one.
    advance(60 * 60 * 1000);
    expect((await statusesOf(sim, storage, [la]))[0]?.usedMs).toBeLessThanOrEqual(60_000);
  });
});

describe("day boundaries", () => {
  it("localDayStart is local midnight", () => {
    const start = localDayStart(at(15, 13, 45));
    expect(start).toBe(at(15, 0));
    expect(localDayStart(at(15, 0))).toBe(at(15, 0));
  });
});
