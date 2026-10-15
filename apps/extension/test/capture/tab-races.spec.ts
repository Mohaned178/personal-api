import { describe, expect, it } from "vitest";
import type { CaptureGate } from "../../lib/capture";
import { newSim, type Sim, setupSimTests } from "./support/sim";

// M2-04 review (PR #58): tab_opened and the completed navigation of the same tab can commit in
// either order. openTab awaits two gate calls, capture awaits one, and with an asynchronous gate
// (M2-07) the order is nondeterministic even in a warm worker. Whatever the order, one navigation
// gives one page_visited, and the tab keeps one tabRef.

setupSimTests();

const URL_A = "https://a.test/page";

/** An asynchronous gate: the answer for events without a page comes later than for a page. */
const slowNullGate: CaptureGate = {
  allows: async (page) => {
    const ticks = page === null ? 5 : 1;
    for (let i = 0; i < ticks; i++) await Promise.resolve();
    return true;
  },
};

/** An asynchronous gate: the answer for a page comes later than for events without a page. */
const slowPageGate: CaptureGate = {
  allows: async (page) => {
    const ticks = page === null ? 1 : 5;
    for (let i = 0; i < ticks; i++) await Promise.resolve();
    return true;
  },
};

const gates: [string, CaptureGate | undefined][] = [
  ["sync gate", undefined],
  ["async gate, page answered first", slowNullGate],
  ["async gate, page answered last", slowPageGate],
];

/** A new tab that completes: onCreated and onUpdated(complete) delivered without waiting. */
async function burst(sim: Sim, withStart = false): Promise<number> {
  const tab = sim.browser.addTab(sim.windowId, URL_A, true, false);
  const snap = sim.browser.snapshot(tab);
  await Promise.all([
    ...(withStart ? [sim.start()] : []),
    sim.fire.tabCreated(snap),
    sim.fire.tabUpdated(tab.id, { status: "complete" }, snap),
  ]);
  return tab.id;
}

function refsOf(sim: Sim): Set<unknown> {
  return new Set([
    ...sim.data("browser.tab_opened").map((d) => d.tabRef),
    ...sim.visits().map((v) => v.tabRef),
  ]);
}

describe("tab_opened racing the first navigation of the tab", () => {
  for (const [name, gate] of gates) {
    it(`warm worker, ${name}: one page_visited and one tabRef, also after a restart`, async () => {
      const sim = newSim(gate ? { gate } : {});
      await sim.start();
      await burst(sim);
      sim.restartWorker();
      await sim.start();
      expect(sim.visits()).toHaveLength(1);
      expect(sim.data("browser.tab_opened")).toHaveLength(1);
      expect(refsOf(sim).size).toBe(1);
    });

    it(`cold worker, ${name}: one page_visited and one tabRef, also after a restart`, async () => {
      const sim = newSim(gate ? { gate } : {});
      await sim.start();
      sim.restartWorker(); // the events wake a fresh background
      await burst(sim);
      sim.restartWorker();
      await sim.start();
      expect(sim.visits()).toHaveLength(1);
      expect(sim.data("browser.tab_opened")).toHaveLength(1);
      expect(refsOf(sim).size).toBe(1);
    });

    it(`cold start of a new browser session, ${name}: one page_visited and one tabRef`, async () => {
      const sim = newSim(gate ? { gate } : {});
      await burst(sim);
      sim.restartWorker();
      await sim.start();
      expect(sim.visits()).toHaveLength(1);
      expect(refsOf(sim).size).toBe(1);
    });

    it(`start() racing onCreated and onUpdated(complete) for a tab, ${name}: one page_visited`, async () => {
      const sim = newSim(gate ? { gate } : {});
      await sim.start();
      sim.restartWorker(); // the tab appeared while the background was dead
      await burst(sim, true);
      expect(sim.visits()).toHaveLength(1);
      expect(refsOf(sim).size).toBe(1);
      sim.restartWorker();
      await sim.start();
      expect(sim.visits()).toHaveLength(1);
      expect(refsOf(sim).size).toBe(1);
    });
  }
});
