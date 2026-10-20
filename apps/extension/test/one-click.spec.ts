import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectError, type Connection } from "../lib/connect";
import {
  CONNECT_DONE_PATH,
  CONNECT_PATH,
  createOneClickHandler,
  ONE_CLICK_ERROR_STORAGE_KEY,
  ONE_CLICK_STORAGE_KEY,
  ONE_CLICK_TTL_MS,
  type OneClickHandlerDeps,
  type OneClickStartDeps,
  readPairingCodeFromUrl,
  startOneClick,
} from "../lib/one-click";
import { sanitizeUrl } from "../lib/sanitize-url";

// M8-01: one-click connect. The popup opens `<server>/connect-extension` in a tab it remembers;
// the background takes the pairing code ONLY from that tab's `/connect-extension/done#code=` URL
// on that exact origin, redeems it, and closes the tab. The code is never stored or logged.

const ORIGIN = "https://api.example.com";
const CODE = "ABCD-EFGH-JKLM-NPQR-STUV";
const T0 = Date.UTC(2026, 9, 21, 10, 0, 0);
const TAB = 42;
const doneUrl = (origin = ORIGIN, code = CODE) => `${origin}${CONNECT_DONE_PATH}#code=${code}`;

const connection: Connection = {
  serverOrigin: ORIGIN,
  ingestKey: "pa_ing_SECRETKEYSECRETKEYSECRETKEY",
  integrationId: "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b",
  integrationName: "Firefox",
};

function memory(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const writes: unknown[] = [];
  return {
    data,
    writes,
    get: vi.fn(async (key: string) => (key in data ? { [key]: data[key] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => {
      writes.push(structuredClone(items));
      Object.assign(data, items);
    }),
    remove: vi.fn(async (key: string) => {
      delete data[key];
    }),
  };
}

const pending = (over: Partial<{ tabId: number; origin: string; expiresAt: number }> = {}) => ({
  [ONE_CLICK_STORAGE_KEY]: {
    tabId: TAB,
    origin: ORIGIN,
    expiresAt: T0 + ONE_CLICK_TTL_MS,
    ...over,
  },
});

function handler(initial: Record<string, unknown> = pending(), now = T0) {
  const session = memory(initial);
  const pair = vi.fn(async (_origin: string, _code: string) => connection);
  const tabs = { remove: vi.fn(async (_tabId: number) => undefined) };
  const deps = { session, pair, tabs, now: () => now } satisfies OneClickHandlerDeps;
  return { h: createOneClickHandler(deps), session, pair, tabs };
}

afterEach(() => vi.restoreAllMocks());

describe("readPairingCodeFromUrl", () => {
  it("reads the code from the done page on the exact origin", () => {
    expect(readPairingCodeFromUrl(doneUrl(), ORIGIN)).toBe(CODE);
  });

  it.each([
    ["another origin", doneUrl("https://evil.example.com")],
    ["another port", doneUrl("https://api.example.com:8443")],
    ["another scheme", doneUrl("http://api.example.com")],
    ["a subdomain", doneUrl("https://x.api.example.com")],
    ["another path", `${ORIGIN}/connect-extension/done/x#code=${CODE}`],
    ["the start page", `${ORIGIN}${CONNECT_PATH}#code=${CODE}`],
    ["a query instead of a fragment", `${ORIGIN}${CONNECT_DONE_PATH}?code=${CODE}`],
    ["no code", `${ORIGIN}${CONNECT_DONE_PATH}#`],
    ["a malformed code", `${ORIGIN}${CONNECT_DONE_PATH}#code=<script>`],
    ["credentials in the URL", `https://u:p@api.example.com${CONNECT_DONE_PATH}#code=${CODE}`],
    ["garbage", "not a url"],
  ])("ignores %s", (_name, url) => {
    expect(readPairingCodeFromUrl(url, ORIGIN)).toBeNull();
  });
});

describe("the done page as an event", () => {
  it("keeps no trace of the code (the fragment is always stripped)", () => {
    expect(JSON.stringify(sanitizeUrl(doneUrl()))).not.toContain(CODE);
  });
});

describe("startOneClick (popup, inside the click)", () => {
  function startDeps(granted = true) {
    const session = memory();
    const calls: string[] = [];
    const deps = {
      permissions: {
        request: vi.fn((_p: { origins: string[] }) => {
          calls.push("permissions.request");
          return Promise.resolve(granted);
        }),
      },
      tabs: {
        create: vi.fn(async (_p: { url: string }) => {
          calls.push("tabs.create");
          return { id: TAB };
        }),
      },
      session,
      now: () => T0,
    } satisfies OneClickStartDeps;
    return { deps, session, calls };
  }

  it("asks for the origin first (synchronously), then opens the connect page and remembers the tab", async () => {
    const { deps, session, calls } = startDeps();
    const started = startOneClick("https://API.example.com/some/path?x=1", deps);
    // Firefox needs the permission request inside the user gesture: before any await.
    expect(calls).toEqual(["permissions.request"]);
    await started;
    expect(deps.permissions.request).toHaveBeenCalledWith({
      origins: ["https://api.example.com/*"],
    });
    expect(deps.tabs.create).toHaveBeenCalledWith({ url: `${ORIGIN}${CONNECT_PATH}` });
    expect(session.data[ONE_CLICK_STORAGE_KEY]).toEqual({
      tabId: TAB,
      origin: ORIGIN,
      expiresAt: T0 + ONE_CLICK_TTL_MS,
    });
  });

  it("opens nothing when the permission is refused", async () => {
    const { deps, session } = startDeps(false);
    await expect(startOneClick(ORIGIN, deps)).rejects.toMatchObject({ code: "permission_denied" });
    expect(deps.tabs.create).not.toHaveBeenCalled();
    expect(session.data).toEqual({});
  });

  it("rejects an insecure or invalid server URL before asking for anything", async () => {
    const { deps } = startDeps();
    await expect(startOneClick("http://api.example.com", deps)).rejects.toBeInstanceOf(
      ConnectError,
    );
    await expect(startOneClick("", deps)).rejects.toMatchObject({ code: "server_url_invalid" });
    expect(deps.permissions.request).not.toHaveBeenCalled();
  });
});

describe("the background handler", () => {
  it("redeems the code from the tab it opened, then closes the tab and forgets it", async () => {
    const { h, pair, tabs, session } = handler();
    await h.onTabUpdated(TAB, { url: doneUrl() });
    expect(pair).toHaveBeenCalledExactlyOnceWith(ORIGIN, CODE);
    expect(tabs.remove).toHaveBeenCalledWith(TAB);
    expect(session.data[ONE_CLICK_STORAGE_KEY]).toBeUndefined();
  });

  it("also reads the URL from the tab when the change carries only the status", async () => {
    const { h, pair } = handler();
    await h.onTabUpdated(TAB, { status: "complete" }, { url: doneUrl() });
    expect(pair).toHaveBeenCalledExactlyOnceWith(ORIGIN, CODE);
  });

  it("ignores a code from any other tab", async () => {
    const { h, pair, tabs, session } = handler();
    await h.onTabUpdated(TAB + 1, { url: doneUrl() });
    expect(pair).not.toHaveBeenCalled();
    expect(tabs.remove).not.toHaveBeenCalled();
    expect(session.data[ONE_CLICK_STORAGE_KEY]).toBeDefined();
  });

  it.each([
    "https://evil.example.com",
    "http://api.example.com",
    "https://api.example.com:8443",
    "https://api.example.com.evil.com",
  ])("ignores a code on another origin (%s), even in the right tab", async (origin) => {
    const { h, pair, tabs } = handler();
    await h.onTabUpdated(TAB, { url: doneUrl(origin) });
    expect(pair).not.toHaveBeenCalled();
    expect(tabs.remove).not.toHaveBeenCalled();
  });

  it("ignores the done page when no connect is pending", async () => {
    const { h, pair } = handler({});
    await h.onTabUpdated(TAB, { url: doneUrl() });
    expect(pair).not.toHaveBeenCalled();
  });

  it("ignores and forgets an expired pending connect", async () => {
    const { h, pair, session } = handler(pending(), T0 + ONE_CLICK_TTL_MS + 1);
    await h.onTabUpdated(TAB, { url: doneUrl() });
    expect(pair).not.toHaveBeenCalled();
    expect(session.data[ONE_CLICK_STORAGE_KEY]).toBeUndefined();
  });

  it.each([
    ["not an object", "x"],
    ["no tab id", { origin: ORIGIN, expiresAt: T0 + 1000 }],
    ["a non-canonical origin", { tabId: TAB, origin: `${ORIGIN}/`, expiresAt: T0 + 1000 }],
  ])("ignores a malformed pending connect (%s)", async (_name, value) => {
    const { h, pair } = handler({ [ONE_CLICK_STORAGE_KEY]: value });
    await h.onTabUpdated(TAB, { url: doneUrl() });
    expect(pair).not.toHaveBeenCalled();
  });

  it("does not read storage for unrelated navigations", async () => {
    const { h, session } = handler();
    await h.onTabUpdated(7, { url: "https://github.com/" });
    await h.onTabUpdated(7, { status: "loading" }, { url: "https://github.com/" });
    expect(session.get).not.toHaveBeenCalled();
  });

  it("redeems a code once, even when the tab reports the URL twice at the same time", async () => {
    const { h, pair } = handler();
    await Promise.all([
      h.onTabUpdated(TAB, { url: doneUrl() }),
      h.onTabUpdated(TAB, { status: "complete" }, { url: doneUrl() }),
    ]);
    expect(pair).toHaveBeenCalledTimes(1);
  });

  it("survives a background restart: a new handler reads the pending tab from session storage", async () => {
    const session = memory(pending());
    const first = { session, pair: vi.fn(), tabs: { remove: vi.fn() }, now: () => T0 };
    createOneClickHandler(first); // the background that opened the tab, then got killed
    const pair = vi.fn(async () => connection);
    const tabs = { remove: vi.fn(async () => undefined) };
    await createOneClickHandler({ session, pair, tabs, now: () => T0 }).onTabUpdated(TAB, {
      url: doneUrl(),
    });
    expect(pair).toHaveBeenCalledExactlyOnceWith(ORIGIN, CODE);
    expect(tabs.remove).toHaveBeenCalledWith(TAB);
  });

  it("forgets the pending connect when its tab is closed", async () => {
    const { h, session } = handler();
    await h.onTabRemoved(TAB + 1);
    expect(session.data[ONE_CLICK_STORAGE_KEY]).toBeDefined();
    await h.onTabRemoved(TAB);
    expect(session.data[ONE_CLICK_STORAGE_KEY]).toBeUndefined();
  });

  it("on a failed pairing keeps the tab open (it shows the code to type in) and records only the message", async () => {
    const { h, pair, tabs, session } = handler();
    pair.mockRejectedValueOnce(new ConnectError("code_invalid", "The pairing code is invalid."));
    await h.onTabUpdated(TAB, { url: doneUrl() });
    expect(tabs.remove).not.toHaveBeenCalled();
    expect(session.data[ONE_CLICK_STORAGE_KEY]).toBeUndefined();
    expect(session.data[ONE_CLICK_ERROR_STORAGE_KEY]).toBe("The pairing code is invalid.");
  });

  it("never writes the code to storage and never logs anything", async () => {
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const ok = handler();
    await ok.h.onTabUpdated(TAB, { url: doneUrl() });
    const failed = handler();
    failed.pair.mockRejectedValueOnce(new Error(`boom ${CODE}`));
    await failed.h.onTabUpdated(TAB, { url: doneUrl() });

    for (const session of [ok.session, failed.session]) {
      expect(JSON.stringify(session.writes)).not.toContain(CODE);
      expect(JSON.stringify(session.data)).not.toContain(CODE);
    }
    expect(failed.session.data[ONE_CLICK_ERROR_STORAGE_KEY]).toBe(
      "Could not finish connecting. Try again, or enter the pairing code shown in the tab.",
    );
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("never rejects, even when storage fails", async () => {
    const { h, session } = handler();
    session.get.mockRejectedValueOnce(new Error("storage down"));
    await expect(h.onTabUpdated(TAB, { url: doneUrl() })).resolves.toBeUndefined();
    session.get.mockRejectedValueOnce(new Error("storage down"));
    await expect(h.onTabRemoved(TAB)).resolves.toBeUndefined();
  });
});
