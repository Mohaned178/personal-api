import { describe, expect, it } from "vitest";
import { advance, newSim, setupSimTests, span } from "./support/sim";

// M2-04: incognito / private tabs and windows are never collected (PLAN §4, invariant 1 and 3).
// Fail closed: a flag that is not the boolean `false` counts as incognito. Every test ends with a
// normal page as a positive control, so an engine that collects nothing cannot pass.

setupSimTests();

const PRIVATE = "https://private.example/secret/page?token=s3cr3t#frag";
const LEAKS = ["private.example", "/secret/page", "s3cr3t"];

describe("incognito is ignored", () => {
  it("produces no event and no stored trace for an incognito window, while the normal page before it ends exactly at the switch", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, "https://a.test/home");
    advance(4000);
    const incognito = await sim.openWindow({ incognito: true });
    await sim.navigate(incognito.tabId, PRIVATE);
    advance(6000);
    await sim.update(incognito.tabId, { status: "complete" });
    await sim.closeTab(incognito.tabId);
    advance(1000);
    await sim.focusWindow(sim.windowId);
    advance(2000);
    await sim.blur();

    for (const leak of LEAKS) expect(sim.store.dump()).not.toContain(leak);
    expect(sim.visits().map((v) => v.domain)).toEqual(["a.test"]);
    expect(sim.ofType("browser.tab_opened")).toEqual([]);
    expect(sim.ofType("browser.tab_closed")).toEqual([]);
    // Attention before the switch is kept and not inflated; the incognito time is not counted;
    // the normal page resumes when its window regains focus.
    expect(sim.segments().map((s) => [s.domain, ...span(s)])).toEqual([
      ["a.test", 0, 4000],
      ["a.test", 11_000, 13_000],
    ]);
  });

  it("ignores an incognito tab inside a normal window", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, "https://a.test/home");
    advance(2000);
    const tabId = await sim.openTab({ incognito: true });
    await sim.navigate(tabId, PRIVATE);
    advance(3000);
    await sim.closeTab(tabId);
    for (const leak of LEAKS) expect(sim.store.dump()).not.toContain(leak);
    expect(sim.ofType("browser.tab_opened")).toEqual([]);
    expect(sim.segments().map((s) => [s.domain, ...span(s)])).toEqual([["a.test", 0, 2000]]);
    // Positive control: a normal tab is still collected afterwards.
    const normal = await sim.openTab();
    await sim.navigate(normal, "https://b.test/ok");
    expect(sim.data("browser.tab_opened")).toHaveLength(1);
    expect(sim.visits().map((v) => v.domain)).toEqual(["a.test", "b.test"]);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["the string 'false'", "false"],
    ["0", 0],
    ["true", true],
  ])("treats a tab whose incognito flag is %s as incognito (fail closed)", async (_name, flag) => {
    const sim = newSim();
    await sim.start();
    const tabId = await sim.openTab({ incognito: flag });
    await sim.navigate(tabId, PRIVATE);
    advance(2000);
    await sim.blur();
    for (const leak of LEAKS) expect(sim.store.dump()).not.toContain(leak);
    expect(sim.ofType("browser.tab_opened")).toEqual([]);
    expect(sim.segments()).toEqual([]);
    const normal = await sim.openTab({ incognito: false });
    await sim.navigate(normal, "https://b.test/ok");
    expect(sim.visits().map((v) => v.domain)).toEqual(["b.test"]);
  });

  it.each([
    ["undefined", undefined],
    ["the string 'false'", "false"],
    ["true", true],
  ])(
    "opens no focus segment in a window whose incognito flag is %s (fail closed)",
    async (_name, flag) => {
      // Focus segments are decided from the focused window and its active tab, so the window's
      // own flag counts too. (A page_visited is decided from the tab alone, ADR 0002 option B.)
      const sim = newSim();
      await sim.start();
      sim.browser.mustWindow(sim.windowId).incognito = flag;
      await sim.navigate(sim.tabId, "https://a.test/in-flagged-window");
      advance(2000);
      await sim.blur();
      expect(sim.segments()).toEqual([]);
      sim.browser.mustWindow(sim.windowId).incognito = false;
      await sim.focusWindow(sim.windowId);
      advance(1500);
      await sim.blur();
      expect(sim.segments().map((s) => [s.path, s.durationMs])).toEqual([
        ["/in-flagged-window", 1500],
      ]);
    },
  );

  it("stops collecting a tab that becomes incognito-flagged, and ends its earlier segment at that point", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, "https://a.test/home");
    advance(3000);
    sim.browser.mustTab(sim.tabId).incognito = true;
    await sim.navigate(sim.tabId, PRIVATE);
    advance(5000);
    await sim.blur();
    for (const leak of LEAKS) expect(sim.store.dump()).not.toContain(leak);
    expect(sim.visits().map((v) => v.domain)).toEqual(["a.test"]);
    expect(sim.segments().map((s) => [s.domain, ...span(s)])).toEqual([["a.test", 0, 3000]]);
  });

  it("emits nothing at all for an incognito window's whole life, only for the normal tab after it", async () => {
    const sim = newSim();
    await sim.start();
    const before = sim.queue.length;
    const incognito = await sim.openWindow({ incognito: true });
    await sim.navigate(incognito.tabId, PRIVATE);
    await sim.closeTab(incognito.tabId);
    expect(sim.queue.length).toBe(before);
    const normal = await sim.openTab({ windowId: sim.windowId });
    expect(sim.queue.length).toBeGreaterThan(before);
    expect(sim.data("browser.tab_opened")).toHaveLength(1);
    expect(normal).toBeGreaterThan(0);
  });
});
