import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapturedEvent } from "../../lib/capture";
import { advance, FakeBrowser, FakeCaptureStore, FakeEvent, flush, T0 } from "./support/sim";

// Self-tests of the M2-04 test fakes. They must pass before the engine exists: the capture specs
// rely on these fakes behaving like a real IndexedDB transaction and a real `browser.*`.

const event = (id: string): CapturedEvent =>
  ({
    id,
    type: "browser.session_started",
    typeVersion: 1,
    occurredAt: new Date(T0).toISOString(),
    data: { reason: "startup" },
  }) as CapturedEvent;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("FakeCaptureStore", () => {
  it("commits the new state and the events together, and resolves after the commit", async () => {
    const store = new FakeCaptureStore();
    await store.transact((prev) => {
      expect(prev).toBeNull();
      return { state: { n: 1 }, events: [event("a")] };
    });
    expect(store.state).toEqual({ n: 1 });
    expect(store.queue.map((e) => e.id)).toEqual(["a"]);
    expect(store.commits).toBe(1);
  });

  it("stores nothing when compute throws, and rejects", async () => {
    const store = new FakeCaptureStore();
    await expect(
      store.transact(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(store.state).toBeNull();
    expect(store.queue).toEqual([]);
  });

  it("stores neither state nor events when the commit is aborted, then works again", async () => {
    const store = new FakeCaptureStore();
    store.failNextCommits(1);
    await expect(store.transact(() => ({ state: { n: 1 }, events: [event("a")] }))).rejects.toThrow(
      "aborted",
    );
    expect(store.state).toBeNull();
    expect(store.queue).toEqual([]);
    await store.transact(() => ({ state: { n: 2 }, events: [event("b")] }));
    expect(store.state).toEqual({ n: 2 });
    expect(store.queue.map((e) => e.id)).toEqual(["b"]);
  });

  it("aborts only the next commit that carries the named event type", async () => {
    const store = new FakeCaptureStore();
    store.failNextCommitWithEvent("browser.session_started");
    await store.transact(() => ({ state: { n: 1 }, events: [] }));
    await expect(store.transact(() => ({ state: { n: 2 }, events: [event("a")] }))).rejects.toThrow(
      "aborted",
    );
    expect(store.state).toEqual({ n: 1 });
    await store.transact(() => ({ state: { n: 3 }, events: [event("b")] }));
    expect(store.queue.map((e) => e.id)).toEqual(["b"]);
  });

  it("applies overlapping transactions in call order on the latest committed state", async () => {
    const store = new FakeCaptureStore();
    const seen: unknown[] = [];
    const first = store.transact((prev) => {
      seen.push(prev);
      return { state: { n: 1 }, events: [] };
    });
    const second = store.transact((prev) => {
      seen.push(prev);
      return { state: { n: 2 }, events: [] };
    });
    await Promise.all([first, second]);
    expect(seen).toEqual([null, { n: 1 }]);
    expect(store.state).toEqual({ n: 2 });
  });

  it("hands compute a copy, so mutating it cannot change what is stored", async () => {
    const store = new FakeCaptureStore();
    await store.transact(() => ({ state: { list: [1] }, events: [] }));
    await store
      .transact((prev) => {
        (prev as { list: number[] }).list.push(2);
        throw new Error("abandon");
      })
      .catch(() => undefined);
    expect(store.state).toEqual({ list: [1] });
  });

  it("rejects state that is not plain cloneable data", async () => {
    const store = new FakeCaptureStore();
    await expect(store.transact(() => ({ state: { fn: () => 1 }, events: [] }))).rejects.toThrow();
  });

  it("rejects a compute that returns a promise (no await inside a transaction)", async () => {
    const store = new FakeCaptureStore();
    await expect(
      store.transact((() => Promise.resolve({ state: {}, events: [] })) as never),
    ).rejects.toThrow("synchronous");
  });

  it("keeps the commit pending while held, and commits on release", async () => {
    const store = new FakeCaptureStore();
    const release = store.holdCommits();
    let done = false;
    const pending = store
      .transact(() => ({ state: { n: 1 }, events: [event("a")] }))
      .then(() => {
        done = true;
      });
    await flush();
    expect(done).toBe(false);
    expect(store.queue).toEqual([]);
    release();
    await pending;
    expect(done).toBe(true);
    expect(store.queue).toHaveLength(1);
  });
});

describe("FakeBrowser", () => {
  const setup = () => {
    const browser = new FakeBrowser(false);
    const win = browser.addWindow(false, true);
    const tab = browser.addTab(win.id, "https://a.test/", true, false);
    return { browser, win, tab };
  };

  it("reports the focused window and its active tab", async () => {
    const { browser, win, tab } = setup();
    expect(await browser.api.windows.getLastFocused()).toMatchObject({ id: win.id, focused: true });
    const [active] = await browser.api.tabs.query({ active: true, windowId: win.id });
    expect(active).toMatchObject({ id: tab.id, url: "https://a.test/", incognito: false });
  });

  it("keeps the last focused window with focused false after a blur", async () => {
    const { browser, win } = setup();
    browser.setUnfocusedAll();
    expect(await browser.api.windows.getLastFocused()).toMatchObject({
      id: win.id,
      focused: false,
    });
  });

  it("makes queries fail, hang or take time on demand", async () => {
    const { browser } = setup();
    browser.fail.queryState = true;
    await expect(browser.api.idle.queryState(60)).rejects.toThrow();
    browser.fail.queryState = false;
    browser.queryDelayMs = 300;
    await browser.api.idle.queryState(60);
    expect(Date.now()).toBe(T0 + 300);
    browser.hang = true;
    let settled = false;
    void browser.api.windows.getLastFocused().then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    expect(settled).toBe(false);
    expect(browser.queryStateArgs).toEqual([60, 60]);
  });

  it("stores session values and alarms like the real thing", async () => {
    const { browser } = setup();
    await browser.api.storage.session.set({ k: "v" });
    expect(await browser.api.storage.session.get("k")).toEqual({ k: "v" });
    expect(await browser.api.storage.session.get("missing")).toEqual({});
    expect(await browser.api.alarms.get("x")).toBeUndefined();
    await browser.api.alarms.create("x", { periodInMinutes: 0.5 });
    expect(await browser.api.alarms.get("x")).toEqual({ name: "x" });
  });

  it("makes advance move the fake clock", () => {
    advance(1500);
    expect(Date.now()).toBe(T0 + 1500);
  });
});

describe("FakeEvent", () => {
  it("collects listeners and returns what each returned", () => {
    const source = new FakeEvent<(n: number) => Promise<number> | undefined>();
    source.addListener((n) => Promise.resolve(n + 1));
    source.addListener(() => undefined);
    const results = source.invoke(1);
    expect(source.listeners).toHaveLength(2);
    expect(results[0]).toBeInstanceOf(Promise);
    expect(results[1]).toBeUndefined();
  });
});
