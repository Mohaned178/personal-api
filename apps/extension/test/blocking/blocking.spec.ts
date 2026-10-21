// M9-06 focus mode and schedules on the device. Local wall-clock times, so the tests hold in any
// time zone: `at(day, hour, minute)` is October 2026 on this machine's clock (Oct 12 is a Monday).

import type { FocusSession, Schedule } from "@personal-api/contracts";
import { describe, expect, it } from "vitest";
import { activeBlocks, blockingFor, scheduleActive } from "../../lib/blocking/evaluate";
import {
  BLOCKING_ALARM_NAME,
  type BlockTab,
  createBlockingService,
  readActiveBlocks,
} from "../../lib/blocking/service";
import { CONNECTION_STORAGE_KEY } from "../../lib/connect";
import { activeBlockConfig } from "../../lib/rules/active-rules";
import {
  configOf,
  connectionFor,
  domainRule,
  memoryStorage,
  RULES_STORAGE_KEY,
  storedRules,
} from "../rules/support";

const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 9, day, hour, minute).getTime();
const MONDAY = 12;

let counter = 0;
const nextId = () => `0192f1c2-7c1e-7a3b-9f00-${String(++counter).padStart(12, "0")}`;

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: nextId(),
    name: "Work hours",
    patterns: ["reddit.com"],
    days: [0, 1, 2, 3, 4],
    start: "09:00",
    end: "17:00",
    enabled: true,
    ...overrides,
  };
}

function focus(endsAt: number, patterns = ["youtube.com"]): FocusSession {
  return { id: nextId(), patterns, endsAt: new Date(endsAt).toISOString() };
}

describe("a schedule's window", () => {
  const work = schedule();

  it("starts at the start time and ends at the end time (end exclusive)", () => {
    expect(scheduleActive(work, new Date(at(MONDAY, 8, 59)))).toBe(false);
    expect(scheduleActive(work, new Date(at(MONDAY, 9, 0)))).toBe(true);
    expect(scheduleActive(work, new Date(at(MONDAY, 16, 59)))).toBe(true);
    expect(scheduleActive(work, new Date(at(MONDAY, 17, 0)))).toBe(false);
  });

  it("only runs on its weekdays (0 = Monday)", () => {
    expect(scheduleActive(work, new Date(at(MONDAY + 4, 12)))).toBe(true); // Friday
    expect(scheduleActive(work, new Date(at(MONDAY + 5, 12)))).toBe(false); // Saturday
    expect(scheduleActive(work, new Date(at(MONDAY + 6, 12)))).toBe(false); // Sunday
  });

  describe("crossing midnight (23:00 to 07:00, starting on Friday only)", () => {
    const night = schedule({ days: [4], start: "23:00", end: "07:00" });

    it("is on from the start time on the day it starts", () => {
      expect(scheduleActive(night, new Date(at(MONDAY + 4, 22, 59)))).toBe(false);
      expect(scheduleActive(night, new Date(at(MONDAY + 4, 23, 0)))).toBe(true);
    });

    it("continues into the next morning and ends at the end time", () => {
      expect(scheduleActive(night, new Date(at(MONDAY + 5, 6, 59)))).toBe(true);
      expect(scheduleActive(night, new Date(at(MONDAY + 5, 7, 0)))).toBe(false);
    });

    it("does not run on the early morning of the start day, or the night after", () => {
      expect(scheduleActive(night, new Date(at(MONDAY + 4, 3)))).toBe(false);
      expect(scheduleActive(night, new Date(at(MONDAY + 5, 23, 30)))).toBe(false);
    });

    it("wraps from Sunday to Monday", () => {
      const sunday = schedule({ days: [6], start: "22:00", end: "06:00" });
      expect(scheduleActive(sunday, new Date(at(MONDAY + 7, 5)))).toBe(true);
      expect(scheduleActive(sunday, new Date(at(MONDAY + 7, 6)))).toBe(false);
    });
  });
});

describe("active blocks", () => {
  it("a focus session is on until its end time, not after", () => {
    const session = focus(at(MONDAY, 15, 45));
    expect(activeBlocks(session, [], at(MONDAY, 15, 44) + 59_000)).toHaveLength(1);
    expect(activeBlocks(session, [], at(MONDAY, 15, 45))).toEqual([]);
    expect(activeBlocks(session, [], at(MONDAY, 18))).toEqual([]);
  });

  it("names the local time a block ends", () => {
    const [block] = activeBlocks(focus(at(MONDAY, 15, 5)), [], at(MONDAY, 14, 30));
    expect(block).toMatchObject({ kind: "focus", until: "15:05" });
    const [scheduled] = activeBlocks(null, [schedule()], at(MONDAY, 10));
    expect(scheduled).toMatchObject({ kind: "schedule", until: "17:00", name: "Work hours" });
  });

  it("ignores a disabled schedule and a malformed end time", () => {
    expect(activeBlocks(null, [schedule({ enabled: false })], at(MONDAY, 10))).toEqual([]);
    const broken = { id: nextId(), patterns: ["x.com"], endsAt: "not a date" } as FocusSession;
    expect(activeBlocks(broken, [], at(MONDAY, 10))).toEqual([]);
  });

  it("overlapping schedules are both on, and the focus session is found first", () => {
    const wide = schedule({ patterns: ["*.reddit.com", "x.com"], start: "08:00", end: "18:00" });
    const narrow = schedule({
      name: "Deep work",
      patterns: ["x.com"],
      start: "10:00",
      end: "12:00",
    });
    const session = focus(at(MONDAY, 11), ["x.com"]);
    const blocks = activeBlocks(session, [wide, narrow], at(MONDAY, 10, 30));
    expect(blocks.map((b) => b.kind)).toEqual(["focus", "schedule", "schedule"]);
    expect(blockingFor(blocks, "x.com")?.kind).toBe("focus");
    // At 11:30 the session is over and the first schedule that covers the site speaks.
    const later = activeBlocks(session, [wide, narrow], at(MONDAY, 11, 30));
    expect(later.map((b) => b.id)).toEqual([wide.id, narrow.id]);
    expect(blockingFor(later, "x.com")?.id).toBe(wide.id);
    // After the narrow window only the wide one is left.
    expect(activeBlocks(null, [wide, narrow], at(MONDAY, 12)).map((b) => b.id)).toEqual([wide.id]);
  });

  it("matches a pattern like a limit does: example.com is that site, *.example.com its subdomains", () => {
    const blocks = activeBlocks(
      null,
      [schedule({ patterns: ["reddit.com", "*.youtube.com"] })],
      at(MONDAY, 10),
    );
    expect(blockingFor(blocks, "reddit.com")).not.toBeNull();
    expect(blockingFor(blocks, "old.reddit.com")).toBeNull();
    expect(blockingFor(blocks, "m.youtube.com")).not.toBeNull();
    expect(blockingFor(blocks, "youtube.com")).toBeNull();
    expect(blockingFor(blocks, "example.org")).toBeNull();
  });
});

const BLOCKED = (kind: string, id: string) => `moz-extension://abc/time-up.html?${kind}=${id}`;

/** One device: storage with stored rules, a clock, a tab list and a record of every redirect. */
function device(
  options: {
    focus?: FocusSession | null;
    schedules?: Schedule[];
    start?: number;
    tabs?: BlockTab[];
  } = {},
) {
  let clock = options.start ?? at(MONDAY, 12);
  const config = configOf([domainRule("Allow", "a.test", "allow")], {
    focus: options.focus ?? null,
    schedules: options.schedules ?? [],
  });
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
    tabs: options.tabs ?? ([] as BlockTab[]),
    redirects: [] as { tabId: number; url: string }[],
    alarms: [] as string[],
    service() {
      return createBlockingService({
        storage,
        now: world.now,
        tabs: {
          query: async () => world.tabs.map((tab) => ({ ...tab })),
          update: async (tabId, { url }) => {
            world.redirects.push({ tabId, url });
          },
        },
        alarms: {
          get: async () => undefined,
          create: (name) => {
            world.alarms.push(name);
          },
        },
        blockedUrl: (block) => BLOCKED(block.kind === "focus" ? "f" : "s", block.id),
      });
    },
  };
  return world;
}

const tab = (id: number, url: string, incognito = false): BlockTab => ({ id, url, incognito });

describe("the blocking service", () => {
  it("moves a tab on a blocked site to the block page, with the id and nothing else", async () => {
    const work = schedule();
    const world = device({
      schedules: [work],
      tabs: [
        tab(1, "https://reddit.com/r/typescript?q=secret#frag"),
        tab(2, "https://example.org/"),
      ],
    });
    await world.service().tick();
    expect(world.redirects).toEqual([{ tabId: 1, url: BLOCKED("s", work.id) }]);
    expect(world.redirects[0]?.url).not.toContain("reddit");
    expect(world.redirects[0]?.url).not.toContain("secret");
  });

  it("a focus session blocks until its end, then lets the site through again", async () => {
    const session = focus(at(MONDAY, 12, 45));
    const world = device({ focus: session, tabs: [tab(1, "https://youtube.com/watch?v=1")] });
    const service = world.service();
    await service.tick();
    expect(world.redirects).toEqual([{ tabId: 1, url: BLOCKED("f", session.id) }]);

    world.redirects.length = 0;
    world.clock = at(MONDAY, 12, 45);
    await service.tick();
    expect(world.redirects).toEqual([]);
  });

  it("a schedule starts and ends on the boundary", async () => {
    const world = device({
      schedules: [schedule()],
      start: at(MONDAY, 8, 59) + 30_000,
      tabs: [tab(1, "https://reddit.com/")],
    });
    const service = world.service();
    await service.tick();
    expect(world.redirects).toEqual([]);
    world.clock = at(MONDAY, 9, 0);
    await service.tick();
    expect(world.redirects).toHaveLength(1);
    world.redirects.length = 0;
    world.clock = at(MONDAY, 17, 0);
    await service.tick();
    expect(world.redirects).toEqual([]);
  });

  it("a background restart mid-block enforces it again from storage alone", async () => {
    const session = focus(at(MONDAY, 13));
    const world = device({ focus: session, tabs: [tab(1, "https://youtube.com/")] });
    await world.service().tick();
    world.redirects.length = 0;
    // A new service instance: nothing in memory, the block is read from storage.
    world.clock = at(MONDAY, 12, 20);
    await world.service().start();
    expect(world.redirects).toEqual([{ tabId: 1, url: BLOCKED("f", session.id) }]);
    expect(world.alarms).toEqual([BLOCKING_ALARM_NAME]);
  });

  it("never touches a private window, a tab without an address or a page that is not a site", async () => {
    const world = device({
      focus: focus(at(MONDAY, 13), ["youtube.com", "localhost"]),
      tabs: [
        tab(1, "https://youtube.com/", true),
        { id: 2, url: "https://youtube.com/" },
        { id: 3 },
        tab(4, "about:blank"),
        tab(5, "moz-extension://abc/time-up.html?f=x"),
      ],
    });
    await world.service().tick();
    expect(world.redirects).toEqual([]);
  });

  it("blocks nothing when the stored rules belong to another connection", async () => {
    const world = device({ focus: focus(at(MONDAY, 13)), tabs: [tab(1, "https://youtube.com/")] });
    world.storage.stored[RULES_STORAGE_KEY] = storedRules(
      configOf([domainRule("Allow", "a.test", "allow")], { focus: focus(at(MONDAY, 13)) }),
      { connection: connectionFor(undefined, { integrationId: "another-integration" }) },
    );
    await world.service().tick();
    expect(world.redirects).toEqual([]);
    expect(await readActiveBlocks({ storage: world.storage, now: world.now })).toEqual([]);
  });

  it("blocks nothing without a connection or with unreadable storage", async () => {
    const world = device({ focus: focus(at(MONDAY, 13)), tabs: [tab(1, "https://youtube.com/")] });
    delete world.storage.stored[CONNECTION_STORAGE_KEY];
    await world.service().tick();
    expect(world.redirects).toEqual([]);
    const broken = { get: async () => Promise.reject(new Error("storage is gone")) };
    expect(await readActiveBlocks({ storage: broken, now: world.now })).toEqual([]);
    const service = createBlockingService({
      storage: broken,
      now: world.now,
      tabs: { query: async () => [], update: async () => undefined },
      alarms: { get: async () => undefined, create: () => undefined },
      blockedUrl: () => "x",
    });
    await expect(service.tick()).resolves.toBeUndefined();
  });

  it("keeps going when one tab cannot be updated", async () => {
    const session = focus(at(MONDAY, 13));
    const world = device({
      focus: session,
      tabs: [tab(1, "https://youtube.com/a"), tab(2, "https://youtube.com/b")],
    });
    const seen: number[] = [];
    const service = createBlockingService({
      storage: world.storage,
      now: world.now,
      tabs: {
        query: async () => world.tabs,
        update: async (tabId) => {
          seen.push(tabId);
          if (tabId === 1) throw new Error("tab is gone");
          return undefined;
        },
      },
      alarms: { get: async () => undefined, create: () => undefined },
      blockedUrl: (block) => BLOCKED("f", block.id),
    });
    await service.tick();
    expect(seen).toEqual([1, 2]);
  });

  it("evaluates only for its own alarm", async () => {
    const world = device({ focus: focus(at(MONDAY, 13)), tabs: [tab(1, "https://youtube.com/")] });
    const service = world.service();
    expect(service.onAlarm({ name: "pa-limits" })).toBeUndefined();
    await service.onAlarm({ name: BLOCKING_ALARM_NAME });
    expect(world.redirects).toHaveLength(1);
  });

  it("writes nothing to storage: the service has no way to", async () => {
    const world = device({ focus: focus(at(MONDAY, 13)), tabs: [tab(1, "https://youtube.com/")] });
    const before = JSON.stringify(world.storage.stored);
    await world.service().tick();
    expect(JSON.stringify(world.storage.stored)).toBe(before);
  });
});

describe("the stored config", () => {
  it("a config stored before M9-06 has no blocks", () => {
    const old = storedRules(configOf([]));
    const legacy = {
      ...old,
      config: { ruleSetVersion: 0, defaultPolicy: "deny", rules: [], limits: [] },
    };
    expect(activeBlockConfig(legacy, connectionFor())).toEqual({ focus: null, schedules: [] });
    expect(activeBlockConfig("garbage", connectionFor())).toEqual({ focus: null, schedules: [] });
    expect(activeBlockConfig(old, null)).toEqual({ focus: null, schedules: [] });
  });

  it("hands out the session and the schedules of valid rules", () => {
    const work = schedule();
    const session = focus(at(MONDAY, 13));
    const stored = storedRules(configOf([], { focus: session, schedules: [work] }));
    expect(activeBlockConfig(stored, connectionFor())).toEqual({
      focus: session,
      schedules: [work],
    });
  });
});
