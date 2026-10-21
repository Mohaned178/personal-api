// M9-05 pause before opening, on fixed data: which tabs are paused, what "Continue" leaves behind,
// and that no address is ever written to storage.

import { describe, expect, it } from "vitest";
import { secondsLeft } from "../../lib/before-open/countdown";
import { createBeforeOpenService, matchPick } from "../../lib/before-open/service";
import {
  addPick,
  allowedKey,
  BEFORE_OPEN_STORAGE_KEY,
  PICKS_MAX,
  parseConfig,
  readConfig,
  removePick,
  setSeconds,
} from "../../lib/before-open/state";
import { memoryStorage } from "../rules/support";

const YOUTUBE = { id: "pick-youtube", pattern: "youtube.com" };
const REDDIT = { id: "pick-reddit", pattern: "*.reddit.com" };

const PAUSE_PAGE = (id: string) => `moz-extension://test/before-open.html?p=${id}`;

/** One device: picked sites in local storage, a session store, and a log of everything shown. */
function device(sites = [YOUTUBE, REDDIT], seconds = 5) {
  const local = memoryStorage({ [BEFORE_OPEN_STORAGE_KEY]: { seconds, sites } });
  const session = memoryStorage();
  const moved: { tabId: number; url: string }[] = [];
  const writes: unknown[] = [];
  const spy = (storage: ReturnType<typeof memoryStorage>) => {
    const set = storage.set;
    storage.set = async (items) => {
      writes.push(items);
      return set(items);
    };
  };
  spy(local);
  spy(session);
  const service = createBeforeOpenService({
    local,
    session,
    tabs: {
      update: async (tabId, { url }) => {
        moved.push({ tabId, url });
      },
    },
    pageUrl: PAUSE_PAGE,
  });
  /** The user opens `url` in `tabId`. */
  const open = (tabId: number, url: string, incognito = false) =>
    service.onTabUpdated(tabId, { url }, { incognito });
  return { local, session, moved, writes, service, open };
}

describe("which tabs are paused", () => {
  it("pauses a picked site and sends the tab to the pause page of that pick", async () => {
    const d = device();
    await d.open(1, "https://youtube.com/watch?v=abc");
    expect(d.moved).toEqual([{ tabId: 1, url: PAUSE_PAGE("pick-youtube") }]);
  });

  it("leaves a site that is not picked alone", async () => {
    const d = device();
    await d.open(1, "https://example.com/");
    await d.open(1, "https://notyoutube.com/");
    await d.open(1, "https://youtube.com.evil.test/");
    expect(d.moved).toEqual([]);
  });

  it("matches an exact pattern for that site only and a wildcard for subdomains only", async () => {
    const d = device();
    await d.open(1, "https://www.youtube.com/");
    await d.open(2, "https://reddit.com/");
    expect(d.moved).toEqual([]);
    await d.open(3, "https://old.reddit.com/r/all");
    expect(d.moved).toEqual([{ tabId: 3, url: PAUSE_PAGE("pick-reddit") }]);
  });

  it("does nothing when no site is picked", async () => {
    const d = device([]);
    await d.open(1, "https://youtube.com/");
    expect(d.moved).toEqual([]);
  });

  it("never touches a private window, or a tab whose privacy is unknown", async () => {
    const d = device();
    await d.open(1, "https://youtube.com/", true);
    await d.service.onTabUpdated(2, { url: "https://youtube.com/" }, {});
    expect(d.moved).toEqual([]);
  });

  it("ignores pages that are not web pages", async () => {
    const d = device();
    await d.open(1, "moz-extension://test/popup.html");
    await d.open(2, "about:blank");
    await d.open(3, "file:///youtube.com/");
    expect(d.moved).toEqual([]);
  });

  it("ignores a tab update that carries no new address", async () => {
    const d = device();
    await d.service.onTabUpdated(1, {}, { incognito: false });
    expect(d.moved).toEqual([]);
  });

  it("fails closed on a config that is missing, malformed or unreadable", async () => {
    const d = device();
    await d.local.set({ [BEFORE_OPEN_STORAGE_KEY]: "nonsense" });
    await d.open(1, "https://youtube.com/");
    d.local.get = async () => {
      throw new Error("storage is gone");
    };
    await d.open(2, "https://youtube.com/");
    expect(d.moved).toEqual([]);
  });

  it("matchPick answers from the domain only", () => {
    const config = { seconds: 5, sites: [YOUTUBE] };
    expect(matchPick(config, "https://youtube.com/anything?q=1#x")).toEqual(YOUTUBE);
    expect(matchPick(config, "not a url")).toBeNull();
    expect(matchPick(config, undefined)).toBeNull();
  });
});

describe("continuing", () => {
  it("does not pause again after Continue, inside the same site", async () => {
    const d = device();
    await d.open(1, "https://youtube.com/watch?v=abc");
    expect(d.moved).toHaveLength(1);
    // The pause page marks the tab, then goes back in the tab's history.
    await d.session.set({ [allowedKey(1)]: "pick-youtube" });
    await d.open(1, "https://youtube.com/watch?v=abc");
    await d.open(1, "https://youtube.com/results");
    expect(d.moved).toHaveLength(1);
  });

  it("pauses again after the tab left the site and came back", async () => {
    const d = device();
    await d.session.set({ [allowedKey(1)]: "pick-youtube" });
    await d.open(1, "https://example.com/");
    expect(d.session.stored).not.toHaveProperty(allowedKey(1));
    await d.open(1, "https://youtube.com/");
    expect(d.moved).toEqual([{ tabId: 1, url: PAUSE_PAGE("pick-youtube") }]);
  });

  it("clears the marker when the tab goes to a page that is not a web page", async () => {
    const d = device();
    await d.session.set({ [allowedKey(1)]: "pick-youtube" });
    await d.open(1, "about:newtab");
    expect(d.session.stored).not.toHaveProperty(allowedKey(1));
  });

  it("does not carry the marker to another picked site, or to another tab", async () => {
    const d = device();
    await d.session.set({ [allowedKey(1)]: "pick-youtube" });
    await d.open(1, "https://old.reddit.com/");
    await d.open(2, "https://youtube.com/");
    expect(d.moved.map((move) => move.url)).toEqual([
      PAUSE_PAGE("pick-reddit"),
      PAUSE_PAGE("pick-youtube"),
    ]);
  });

  it("forgets the marker when the tab is closed", async () => {
    const d = device();
    await d.session.set({ [allowedKey(7)]: "pick-youtube" });
    await d.service.onTabRemoved(7);
    expect(d.session.stored).toEqual({});
  });

  it("leaves the tab alone when the browser refuses to move it", async () => {
    const d = device();
    const failing = createBeforeOpenService({
      local: d.local,
      session: d.session,
      tabs: {
        update: async () => {
          throw new Error("tab is gone");
        },
      },
      pageUrl: PAUSE_PAGE,
    });
    await expect(
      failing.onTabUpdated(1, { url: "https://youtube.com/" }, { incognito: false }),
    ).resolves.toBeUndefined();
  });
});

describe("what is stored", () => {
  it("never writes an address, a path or a query, and the pause page address carries only the pick id", async () => {
    const d = device();
    const url = "https://youtube.com/watch?v=SECRET-VIDEO&t=99#frag";
    await d.open(1, url);
    await d.session.set({ [allowedKey(1)]: "pick-youtube" });
    await d.open(1, url);
    await d.open(1, "https://youtube.com/results?search_query=private");
    await d.open(2, "https://example.com/private/path?x=1");
    await d.service.onTabRemoved(1);

    const everything = JSON.stringify([d.writes, d.moved, d.local.stored, d.session.stored]);
    for (const secret of [
      "SECRET-VIDEO",
      "watch",
      "frag",
      "search_query",
      "private",
      "example.com",
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(d.moved[0]?.url).toBe(PAUSE_PAGE("pick-youtube"));
  });
});

describe("the picked sites", () => {
  let counter = 0;
  const newId = () => `id-${++counter}`;

  it("adds a valid pattern in lower case and refuses a duplicate", async () => {
    const storage = memoryStorage();
    expect(await addPick(storage, "  YouTube.com ", newId)).toBe("added");
    expect(await addPick(storage, "youtube.com", newId)).toBe("exists");
    expect((await readConfig(storage)).sites.map((site) => site.pattern)).toEqual(["youtube.com"]);
  });

  it("refuses anything that is not a domain pattern, such as an address", async () => {
    const storage = memoryStorage();
    for (const bad of [
      "",
      "https://youtube.com/watch",
      "youtube.com/watch",
      "a b",
      "*",
      "*.*.com",
    ]) {
      expect(await addPick(storage, bad, newId)).toBe("invalid");
    }
    expect(storage.stored).toEqual({});
  });

  it("stops at the limit", async () => {
    const storage = memoryStorage();
    for (let i = 0; i < PICKS_MAX; i++) await addPick(storage, `site${i}.test`, newId);
    expect(await addPick(storage, "one-more.test", newId)).toBe("full");
  });

  it("removes a pick by id", async () => {
    const storage = memoryStorage({
      [BEFORE_OPEN_STORAGE_KEY]: { seconds: 5, sites: [YOUTUBE, REDDIT] },
    });
    await removePick(storage, "pick-youtube");
    expect((await readConfig(storage)).sites).toEqual([REDDIT]);
  });

  it("keeps the pause between 5 and 10 seconds", async () => {
    const storage = memoryStorage();
    expect(await setSeconds(storage, 8)).toBe(true);
    expect((await readConfig(storage)).seconds).toBe(8);
    for (const bad of [4, 11, 7.5, Number.NaN]) expect(await setSeconds(storage, bad)).toBe(false);
    expect((await readConfig(storage)).seconds).toBe(8);
  });

  it("drops malformed entries and falls back to the default length", () => {
    const config = parseConfig({
      seconds: 99,
      sites: [
        YOUTUBE,
        { id: "", pattern: "x.test" },
        { id: "a", pattern: "https://x.test/p" },
        3,
        null,
      ],
    });
    expect(config).toEqual({ seconds: 5, sites: [YOUTUBE] });
    expect(parseConfig(undefined)).toEqual({ seconds: 5, sites: [] });
    expect(parseConfig([YOUTUBE])).toEqual({ seconds: 5, sites: [] });
  });
});

describe("the countdown", () => {
  it("counts whole seconds down to 0 and stays there", () => {
    expect(secondsLeft(1_000, 1_000, 5)).toBe(5);
    expect(secondsLeft(1_000, 1_001, 5)).toBe(5);
    expect(secondsLeft(1_000, 2_000, 5)).toBe(4);
    expect(secondsLeft(1_000, 5_999, 5)).toBe(1);
    expect(secondsLeft(1_000, 6_000, 5)).toBe(0);
    expect(secondsLeft(1_000, 60_000, 5)).toBe(0);
  });
});
