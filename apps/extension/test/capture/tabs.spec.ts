import { tabRefSchema } from "@personal-api/contracts";
import { describe, expect, it } from "vitest";
import { advance, allowDomains, iso, newSim, setupSimTests, T0 } from "./support/sim";

// M2-04: browser.tab_opened / browser.tab_closed and the per-browser-session tab reference
// (PLAN §4: a random id, never the browser's tab id).

setupSimTests();

describe("tab_opened and tab_closed", () => {
  it("emits tab_opened when a tab is created and tab_closed when it is removed, with the same tabRef", async () => {
    const sim = newSim();
    await sim.start();
    const tabId = await sim.openTab();
    advance(1000);
    await sim.closeTab(tabId);
    const [opened] = sim.data("browser.tab_opened");
    const [closed] = sim.data("browser.tab_closed");
    expect(sim.data("browser.tab_opened")).toHaveLength(1);
    expect(sim.data("browser.tab_closed")).toHaveLength(1);
    expect(opened?.tabRef).toBeTypeOf("string");
    expect(closed?.tabRef).toBe(opened?.tabRef);
    expect(sim.ofType("browser.tab_closed")[0]?.occurredAt).toBe(iso(T0 + 1000));
    expect(sim.ofType("browser.tab_opened")[0]?.occurredAt).toBe(iso(T0));
  });

  it("uses one tabRef for the tab's tab_opened, page_visited and tab_closed", async () => {
    const sim = newSim();
    await sim.start();
    const tabId = await sim.openTab();
    await sim.navigate(tabId, "https://a.test/page");
    await sim.closeTab(tabId);
    const refs = new Set([
      ...sim.data("browser.tab_opened").map((d) => d.tabRef),
      ...sim.visits().map((v) => v.tabRef),
      ...sim.data("browser.tab_closed").map((d) => d.tabRef),
    ]);
    expect(refs.size).toBe(1);
  });

  it("gives different tabs different refs, built by the injected generator, never the tab id", async () => {
    const sim = newSim();
    await sim.start();
    const first = await sim.openTab();
    const second = await sim.openTab();
    const refs = sim.data("browser.tab_opened").map((d) => d.tabRef as string);
    expect(refs).toHaveLength(2);
    expect(new Set(refs).size).toBe(2);
    for (const ref of refs) {
      expect(tabRefSchema.safeParse(ref).success).toBe(true);
      expect(ref.startsWith("tabref-")).toBe(true);
      expect(ref).not.toBe(String(first));
      expect(ref).not.toBe(String(second));
    }
  });

  it("keeps the tabRef of a tab across a background kill", async () => {
    const sim = newSim();
    await sim.start();
    const tabId = await sim.openTab();
    const [opened] = sim.data("browser.tab_opened");
    sim.restartWorker();
    await sim.start();
    await sim.navigate(tabId, "https://a.test/page");
    await sim.closeTab(tabId);
    expect(sim.visits()[0]?.tabRef).toBe(opened?.tabRef);
    expect(sim.data("browser.tab_closed")[0]?.tabRef).toBe(opened?.tabRef);
  });

  it("gives the same tab id a new tabRef after a browser restart", async () => {
    const sim = newSim();
    await sim.start();
    const tabId = await sim.openTab();
    await sim.navigate(tabId, "https://a.test/one");
    const before = sim.visits()[0]?.tabRef;
    advance(60_000);
    sim.restartWorker({ browserSession: true });
    await sim.start();
    await sim.navigate(tabId, "https://a.test/two");
    const after = sim.visits().find((v) => v.path === "/two")?.tabRef;
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  it("gives a reused tab id a new tabRef once the old tab is closed", async () => {
    const sim = newSim();
    await sim.start();
    const tabId = await sim.openTab({ id: 40 });
    await sim.closeTab(tabId);
    await sim.openTab({ id: 40 });
    const [first, second] = sim.data("browser.tab_opened").map((d) => d.tabRef);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("emits nothing when a tab the engine never saw is removed, and only one tab_closed when it is removed twice", async () => {
    const sim = newSim();
    await sim.start();
    await sim.fire.tabRemoved(999, { windowId: sim.windowId, isWindowClosing: false });
    expect(sim.ofType("browser.tab_closed")).toEqual([]);
    const tabId = await sim.openTab();
    await sim.fire.tabRemoved(tabId, { windowId: sim.windowId, isWindowClosing: false });
    await sim.fire.tabRemoved(tabId, { windowId: sim.windowId, isWindowClosing: false });
    expect(sim.ofType("browser.tab_closed")).toHaveLength(1);
  });

  it("only ever puts a sanitized, allowed domain on tab events, never a path or query", async () => {
    const sim = newSim({ gate: allowDomains(["a.test"]) });
    await sim.start();
    const allowed = await sim.openTab({ url: "https://a.test/p?x=secret#f" });
    const denied = await sim.openTab({ url: "https://denied.test/p?x=1" });
    const blank = await sim.openTab({ url: "about:blank" });
    const nonHttp = await sim.openTab({ url: "chrome://settings" });
    for (const tabId of [allowed, denied, blank, nonHttp]) await sim.closeTab(tabId);
    const events = [...sim.data("browser.tab_opened"), ...sim.data("browser.tab_closed")];
    expect(events).toHaveLength(8);
    for (const data of events) {
      if ("domain" in data) expect(data.domain).toBe("a.test");
      expect(Object.keys(data).sort()).toSatisfy((keys: string[]) =>
        keys.every((key) => key === "tabRef" || key === "domain"),
      );
    }
    expect(sim.store.dump()).not.toMatch(/denied\.test|secret|chrome:/);
  });
});
