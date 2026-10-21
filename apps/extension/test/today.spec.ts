// M8-04 the popup's "Today": per-domain time computed on the device from the focus segments the
// rules kept, stored in `browser.storage.local` under the local date, only today's entry kept.

import type { KnownEvent } from "@personal-api/contracts";
import { describe, expect, it } from "vitest";
import type { CaptureStore } from "../lib/capture";
import { createRuleStore } from "../lib/rules/rule-store";
import {
  createTodayCounter,
  createTodayStore,
  formatDuration,
  localDate,
  readToday,
  stopTrackingUrl,
  TODAY_STORAGE_KEY,
  topSites,
} from "../lib/today";
import { advance, newSim, SECOND, setupSimTests } from "./capture/support/sim";
import { active, configOf, domainRule, memoryStorage } from "./rules/support";

setupSimTests();

/** Local wall-clock times, so the tests hold in any time zone. */
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 9, day, hour, minute, 0).getTime();

function segment(domain: string, endedAt: number, durationMs: number): KnownEvent {
  return {
    id: crypto.randomUUID(),
    type: "browser.focus_segment",
    typeVersion: 1,
    occurredAt: new Date(endedAt).toISOString(),
    data: {
      domain,
      path: "/",
      startedAt: new Date(endedAt - durationMs).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      durationMs,
    },
  } as KnownEvent;
}

function visit(domain: string, occurredAt: number): KnownEvent {
  return {
    id: crypto.randomUUID(),
    type: "browser.page_visited",
    typeVersion: 1,
    occurredAt: new Date(occurredAt).toISOString(),
    data: { domain, path: "/", tabRef: "tabref-000001" },
  } as KnownEvent;
}

describe("today counter", () => {
  it("sums focus segment time per domain under the local date, and ignores other events", async () => {
    let clock = at(15, 12);
    const storage = memoryStorage();
    const counter = createTodayCounter({ storage, now: () => clock });
    await counter.add([segment("a.test", at(15, 11), 4000), visit("a.test", at(15, 11))]);
    clock = at(15, 13);
    await counter.add([segment("a.test", at(15, 13), 6000), segment("b.test", at(15, 13), 1000)]);
    expect(storage.stored[TODAY_STORAGE_KEY]).toEqual({
      date: localDate(at(15, 12)),
      ms: { "a.test": 10_000, "b.test": 1000 },
    });
  });

  it("deletes the previous day at rollover when a segment of the new day is counted", async () => {
    const storage = memoryStorage({
      [TODAY_STORAGE_KEY]: { date: localDate(at(14, 20)), ms: { "old.test": 90_000 } },
    });
    const counter = createTodayCounter({ storage, now: () => at(15, 0, 5) });
    await counter.add([segment("a.test", at(15, 0, 4), 2000)]);
    expect(storage.stored[TODAY_STORAGE_KEY]).toEqual({
      date: localDate(at(15, 0, 5)),
      ms: { "a.test": 2000 },
    });
  });

  it("prune deletes the previous day even when nothing is counted after midnight", async () => {
    const storage = memoryStorage({
      [TODAY_STORAGE_KEY]: { date: localDate(at(14, 20)), ms: { "old.test": 90_000 } },
    });
    await createTodayCounter({ storage, now: () => at(15, 0, 1) }).prune();
    expect(storage.stored).not.toHaveProperty(TODAY_STORAGE_KEY);
  });

  it("prune keeps today's entry and deletes a malformed one", async () => {
    const today = { date: localDate(at(15, 9)), ms: { "a.test": 1000 } };
    const kept = memoryStorage({ [TODAY_STORAGE_KEY]: today });
    await createTodayCounter({ storage: kept, now: () => at(15, 10) }).prune();
    expect(kept.stored[TODAY_STORAGE_KEY]).toEqual(today);

    const broken = memoryStorage({ [TODAY_STORAGE_KEY]: { date: 7, ms: "x" } });
    await createTodayCounter({ storage: broken, now: () => at(15, 10) }).prune();
    expect(broken.stored).not.toHaveProperty(TODAY_STORAGE_KEY);
  });

  it("does not count a segment of an earlier day committed after midnight", async () => {
    const storage = memoryStorage();
    const counter = createTodayCounter({ storage, now: () => at(15, 0, 0) + 500 });
    await counter.add([segment("late.test", at(14, 23, 59), 30_000)]);
    expect(readToday(storage.stored[TODAY_STORAGE_KEY], at(15, 0, 1))).toEqual({});
  });

  it("never rejects, even when storage fails", async () => {
    const counter = createTodayCounter({
      storage: {
        get: () => Promise.reject(new Error("boom")),
        set: () => Promise.reject(new Error("boom")),
        remove: () => Promise.reject(new Error("boom")),
      },
      now: () => at(15, 12),
    });
    await expect(counter.add([segment("a.test", at(15, 12), 1000)])).resolves.toBeUndefined();
    await expect(counter.prune()).resolves.toBeUndefined();
  });

  it("serializes concurrent adds so no time is lost", async () => {
    const storage = memoryStorage();
    const counter = createTodayCounter({ storage, now: () => at(15, 12) });
    await Promise.all(
      Array.from({ length: 10 }, () => counter.add([segment("a.test", at(15, 12), 1000)])),
    );
    expect(readToday(storage.stored[TODAY_STORAGE_KEY], at(15, 12))).toEqual({
      "a.test": 10_000,
    });
  });
});

describe("reading today", () => {
  it("shows nothing for an entry of another day, or a malformed one", () => {
    const yesterday = { date: localDate(at(14, 9)), ms: { "a.test": 1000 } };
    expect(readToday(yesterday, at(15, 9))).toEqual({});
    expect(readToday(undefined, at(15, 9))).toEqual({});
    expect(readToday({ date: localDate(at(15, 9)), ms: { "a.test": -5 } }, at(15, 9))).toEqual({});
  });

  it("topSites lists the 5 longest, longest first", () => {
    const ms = { a: 1, b: 7, c: 3, d: 9, e: 5, f: 2 };
    expect(topSites(ms)).toEqual([
      { domain: "d", ms: 9 },
      { domain: "b", ms: 7 },
      { domain: "e", ms: 5 },
      { domain: "c", ms: 3 },
      { domain: "f", ms: 2 },
    ]);
  });
});

describe("Today through the capture engine and the rules", () => {
  const allowA = domainRule("Allow a", "a.test", "allow");
  const dropB = domainRule("Drop b", "b.test", "drop", { priority: 1 });
  const rules = active(configOf([allowA, dropB]));

  /** The background's composition: rules decide inside the commit, Today counts what was kept. */
  const wrapWith =
    (storage: ReturnType<typeof memoryStorage>) =>
    (store: CaptureStore): CaptureStore =>
      createRuleStore({
        store: createTodayStore({
          store,
          counter: createTodayCounter({ storage, now: Date.now }),
        }),
        loadRules: async () => rules,
      });

  const totals = (storage: ReturnType<typeof memoryStorage>) =>
    readToday(storage.stored[TODAY_STORAGE_KEY], Date.now());

  it("counts an allowed site and never a dropped one", async () => {
    const storage = memoryStorage();
    const sim = newSim({ wrapStore: wrapWith(storage) });
    await sim.start();
    await sim.navigate(sim.tabId, "https://b.test/bank");
    advance(5 * SECOND);
    await sim.navigate(sim.tabId, "https://a.test/home");
    advance(3 * SECOND);
    await sim.blur();
    expect(totals(storage)).toEqual({ "a.test": 3000 });
    expect(JSON.stringify(storage.stored)).not.toContain("b.test");
  });

  it("never counts a private window", async () => {
    const storage = memoryStorage();
    const sim = newSim({ wrapStore: wrapWith(storage) });
    await sim.start();
    await sim.navigate(sim.tabId, "https://a.test/home");
    advance(2 * SECOND);
    const incognito = await sim.openWindow({ incognito: true });
    await sim.navigate(incognito.tabId, "https://a.test/private");
    advance(10 * SECOND);
    await sim.closeTab(incognito.tabId);
    await sim.focusWindow(sim.windowId);
    advance(1 * SECOND);
    await sim.blur();
    // Positive control: the normal window's 2 s + 1 s; the 10 s in the private window are not counted.
    expect(totals(storage)).toEqual({ "a.test": 3000 });
  });

  it("keeps the totals across a background restart", async () => {
    const storage = memoryStorage();
    const sim = newSim({ wrapStore: wrapWith(storage) });
    await sim.start();
    await sim.navigate(sim.tabId, "https://a.test/home");
    advance(4 * SECOND);
    await sim.blur();
    sim.restartWorker();
    await sim.start();
    await sim.focusWindow(sim.windowId);
    advance(6 * SECOND);
    await sim.blur();
    expect(totals(storage)).toEqual({ "a.test": 10_000 });
  });
});

describe("stop tracking link", () => {
  const ORIGIN = "https://pa.example.com";

  it("opens the Rules page with the domain only in the fragment", () => {
    const url = stopTrackingUrl(ORIGIN, {
      url: "https://www.github.com/org/repo?token=s3cr3t#frag",
      incognito: false,
    });
    expect(url).toBe("https://pa.example.com/rules#drop=www.github.com");
    const parsed = new URL(url ?? "");
    expect(parsed.search).toBe("");
    expect(parsed.pathname).toBe("/rules");
    expect(url).not.toContain("s3cr3t");
    expect(url).not.toContain("/org/repo");
  });

  it("offers no link for a private tab, a browser page, or the server itself", () => {
    expect(stopTrackingUrl(ORIGIN, { url: "https://a.test/", incognito: true })).toBeNull();
    expect(stopTrackingUrl(ORIGIN, { url: "https://a.test/" })).toBeNull();
    expect(stopTrackingUrl(ORIGIN, { url: "about:addons", incognito: false })).toBeNull();
    expect(stopTrackingUrl(ORIGIN, { url: `${ORIGIN}/rules`, incognito: false })).toBeNull();
    expect(stopTrackingUrl(ORIGIN, undefined)).toBeNull();
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "<1 min"],
    [59_999, "<1 min"],
    [60_000, "1 min"],
    [59 * 60_000 + 59_999, "59 min"],
    [60 * 60_000, "1 h"],
    [65 * 60_000, "1 h 5 min"],
  ])("%d ms is %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});
