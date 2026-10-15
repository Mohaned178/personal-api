import { describe, expect, it } from "vitest";
import {
  advance,
  allowDomains,
  MINUTE,
  newSim,
  SECOND,
  setupSimTests,
  span,
  T0,
} from "./support/sim";

// M2-04: durable state and recovery (ADR 0002 decisions 1, 2, 6, 8 and 9). A "kill" is a second
// engine over the SAME store and `storage.session`; a "browser restart" also clears
// `storage.session` (the browser-session id), like a real restart does.

setupSimTests();

const A = "https://a.test/a";
const B = "https://b.test/b";

const view = (sim: ReturnType<typeof newSim>) =>
  sim.segments().map((s) => [s.domain + s.path, ...span(s)]);

describe("a background kill inside a browser session", () => {
  it("continues the open segment: nothing is emitted at restart and the later close has the full duration", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    advance(1500);
    sim.restartWorker();
    await sim.start();
    expect(sim.segments()).toEqual([]);
    advance(3500);
    await sim.blur();
    expect(view(sim)).toEqual([["a.test/a", 0, 5000]]);
  });

  it("handles the event that woke the stopped background: the segment closes at that event", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    advance(2000);
    sim.restartWorker();
    advance(1000); // the worker was stopped; the user switched tabs and the event woke it
    const second = await sim.openTab();
    await sim.navigate(second, B);
    advance(2000);
    await sim.blur();
    expect(view(sim)).toEqual([
      ["a.test/a", 0, 3000],
      ["b.test/b", 3000, 5000],
    ]);
  });

  it("does not duplicate events when start() runs twice or the first step is retried", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    await sim.beats(1);
    sim.restartWorker();
    await Promise.all([sim.start(), sim.start()]);
    await sim.start();
    const idsAfter = sim.queue.map((e) => e.id);
    expect(new Set(idsAfter).size).toBe(idsAfter.length);
    expect(sim.ofType("browser.page_visited")).toHaveLength(1);
    expect(sim.ofType("browser.session_started")).toHaveLength(1);
    expect(sim.segments()).toEqual([]);
  });

  it("does not emit a second visit for a navigation that was committed before the kill", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    sim.restartWorker();
    await sim.start();
    expect(sim.visits().map((v) => v.path)).toEqual(["/a"]);
  });
});

describe("a failed commit", () => {
  it("leaves neither state nor events behind, lets the listener promise resolve, and is corrected by the next step", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    advance(3000);
    sim.store.failNextCommitWithEvent("browser.focus_segment");
    await expect(sim.blur()).resolves.toBeUndefined(); // the commit that closes the segment is lost
    expect(sim.segments()).toEqual([]);
    advance(2000);
    await sim.heartbeat(); // the world is still blurred: the same segment closes now, once
    expect(view(sim)).toEqual([["a.test/a", 0, 5000]]);
    advance(30 * SECOND);
    await sim.heartbeat();
    expect(sim.segments()).toHaveLength(1);
  });

  it("emits a lost visit once when a later attempt succeeds", async () => {
    const sim = newSim();
    await sim.start();
    const tab = sim.browser.mustTab(sim.tabId);
    tab.url = A;
    sim.store.failNextCommitWithEvent("browser.page_visited");
    await expect(sim.update(sim.tabId, { status: "complete" })).resolves.toBeUndefined();
    expect(sim.visits()).toEqual([]);
    await sim.update(sim.tabId, { status: "complete" });
    expect(sim.visits().map((v) => v.path)).toEqual(["/a"]);
  });
});

describe("a browser restart", () => {
  it("closes the previous session's open segment at the last known alive time, never at the restart", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    await sim.beats(1); // 30 s
    advance(10 * MINUTE); // the browser was down
    sim.restartWorker({ browserSession: true });
    await sim.start();
    expect(view(sim)).toEqual([["a.test/a", 0, 30_000]]);
    expect(sim.segments().reduce((sum, s) => sum + s.durationMs, 0)).toBeLessThan(MINUTE);
  });

  it("recovers exactly once, even if the first step after the restart is repeated", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    await sim.beats(1);
    advance(10 * MINUTE);
    sim.restartWorker({ browserSession: true });
    await sim.start();
    await sim.start();
    sim.restartWorker();
    await sim.start();
    await sim.heartbeat();
    expect(sim.segments()).toHaveLength(1);
  });

  it("drops a segment that was never confirmed alive instead of inflating it", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A); // no heartbeat followed
    advance(10 * MINUTE);
    sim.restartWorker({ browserSession: true });
    await sim.start();
    expect(sim.segments()).toEqual([]);
  });

  it("opens a fresh segment for the page that is focused after the restart", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    await sim.beats(1);
    advance(10 * MINUTE);
    sim.restartWorker({ browserSession: true });
    await sim.start();
    advance(4000);
    await sim.blur();
    expect(view(sim)).toEqual([
      ["a.test/a", 0, 30_000],
      ["a.test/a", 30_000 + 10 * MINUTE, 30_000 + 10 * MINUTE + 4000],
    ]);
  });

  it("caps a recovered segment at 30 minutes without losing the part below the cap", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    await sim.beats(80); // 40 minutes of heartbeats, splits included
    advance(5 * MINUTE);
    sim.restartWorker({ browserSession: true });
    await sim.start();
    const durations = sim.segments().map((s) => s.durationMs);
    expect(durations.every((d) => d > 0 && d <= 30 * MINUTE)).toBe(true);
    expect(durations.reduce((a, b) => a + b, 0)).toBe(40 * MINUTE);
  });
});

describe("reconciliation of open tabs at background start", () => {
  it("emits a visit whose event was lost with the time of the reconciliation, then skips the late event once", async () => {
    const sim = newSim();
    await sim.start();
    const tab = sim.browser.mustTab(sim.tabId);
    // The page finished loading while the background was dying: its event never committed.
    tab.url = "https://a.test/lost?token=s3cr3t";
    advance(2000);
    sim.restartWorker();
    await sim.start();
    expect(sim.visits().map((v) => [v.path, v.occurredAt - T0])).toEqual([["/lost", 2000]]);
    // Chrome re-delivers the event to the new worker: it must not count a second time.
    await sim.update(sim.tabId, { status: "complete" });
    expect(sim.visits()).toHaveLength(1);
    // A real reload afterwards counts.
    await sim.reload(sim.tabId);
    expect(sim.visits()).toHaveLength(2);
    expect(sim.store.dump()).not.toMatch(/s3cr3t|token/);
  });

  it("does not re-emit a page that is already recorded, one still loading, an incognito one or a non-http one", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    const loading = await sim.openTab({ active: false });
    sim.browser.mustTab(loading).url = "https://loading.test/x";
    sim.browser.mustTab(loading).status = "loading";
    const incognito = await sim.openTab({ active: false, incognito: true });
    sim.browser.mustTab(incognito).url = "https://private.example/x";
    const chrome = await sim.openTab({ active: false });
    sim.browser.mustTab(chrome).url = "chrome://settings";
    sim.restartWorker();
    await sim.start();
    expect(sim.visits().map((v) => v.domain)).toEqual(["a.test"]);
    expect(sim.store.dump()).not.toMatch(/loading\.test|private\.example|chrome:/);
  });

  it("recovers a visit for a tab whose recorded page is older than what the tab shows now", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    sim.browser.mustTab(sim.tabId).url = B; // moved on while no worker was alive
    advance(1000);
    sim.restartWorker();
    await sim.start();
    expect(sim.visits().map((v) => v.domain)).toEqual(["a.test", "b.test"]);
  });

  it("ignores marks from a previous browser session, because tab ids are reused", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, A);
    advance(10 * MINUTE);
    sim.restartWorker({ browserSession: true });
    await sim.start();
    expect(sim.visits().map((v) => v.path)).toEqual(["/a", "/a"]);
  });

  it("goes through the rule gate: a denied page is neither emitted nor stored", async () => {
    const sim = newSim({ gate: allowDomains(["ok.test"]) });
    await sim.start();
    sim.browser.mustTab(sim.tabId).url = "https://denied.test/lost/page";
    const other = await sim.openTab({ active: false });
    sim.browser.mustTab(other).url = "https://ok.test/fine";
    sim.restartWorker();
    await sim.start();
    expect(sim.visits().map((v) => v.domain)).toEqual(["ok.test"]);
    expect(sim.store.dump()).not.toMatch(/denied\.test|lost\/page/);
  });

  it("emits nothing and stores nothing about pages when the gate throws during reconciliation", async () => {
    const sim = newSim({
      gate: {
        allows: () => {
          throw new Error("rules unreadable");
        },
      },
    });
    await sim.start();
    sim.browser.mustTab(sim.tabId).url = "https://denied.test/lost/page";
    sim.restartWorker();
    await expect(sim.start()).resolves.toBeUndefined();
    expect(sim.queue).toEqual([]);
    expect(sim.store.dump()).not.toMatch(/denied\.test|lost\/page/);
  });
});

describe("what is stored", () => {
  it("is plain cloneable data holding domain and path only, with the transaction computed synchronously", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, "https://user:pw@a.test:8443/p/q?token=s3cr3t#frag");
    await sim.beats(2);
    const dump = sim.store.dump();
    for (const forbidden of ["s3cr3t", "token", "frag", "user:pw", "8443", "https:"]) {
      expect(dump).not.toContain(forbidden);
    }
    expect(sim.store.commits).toBeGreaterThan(0);
  });

  it("does not leak state between two engines over two stores", async () => {
    const first = newSim();
    await first.start();
    await first.navigate(first.tabId, A);
    await first.beats(1);
    const second = newSim();
    await second.start();
    expect(second.visits()).toEqual([]);
    expect(second.segments()).toEqual([]);
    expect(second.store.dump()).not.toContain("a.test");
    advance(2000);
    await second.navigate(second.tabId, B);
    expect(first.visits().map((v) => v.domain)).toEqual(["a.test"]);
    expect(second.visits().map((v) => v.domain)).toEqual(["b.test"]);
  });
});
