// M8-01 one-click connect (pure; every browser dependency is injected). ADR 0003.
//
// 1. The popup (inside the click) asks for the server origin's permission, opens
//    `<server>/connect-extension` in a new tab and remembers `{ tabId, origin, expiresAt }` in
//    `storage.session`. Never the code: there is none yet.
// 2. The user confirms on that dashboard page, which issues a pairing code and moves the tab to
//    `/connect-extension/done#code=<code>`. The fragment never reaches the server.
// 3. The background sees the tab's URL change. It takes the code only from THAT tab, only on that
//    exact origin and path, redeems it with `POST /v1/pair`, then closes the tab. The code lives in
//    memory for the length of one request: it is never stored, logged or sent anywhere else.

import { ConnectError, type Connection, normalizeServerUrl } from "./connect";

export const CONNECT_PATH = "/connect-extension";
export const CONNECT_DONE_PATH = "/connect-extension/done";

/** `storage.session` key of the pending connect (cleared by a browser restart). */
export const ONE_CLICK_STORAGE_KEY = "pa.connect.pending";
/** `storage.session` key of the last one-click failure message, for the popup. Never a code. */
export const ONE_CLICK_ERROR_STORAGE_KEY = "pa.connect.error";

/**
 * How long the opened tab is trusted. Longer than a pairing code lives (10 minutes) because the
 * user may have to sign in first; the code itself still expires on the server.
 */
export const ONE_CLICK_TTL_MS = 30 * 60 * 1000;

/** The shape the dashboard shows (`XXXX-XXXX-…`), bounded like `pairRequestSchema`. */
const CODE_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

const PERMISSION_DENIED_MESSAGE = "Permission for the server was not granted. Nothing was sent.";
const TAB_FAILED_MESSAGE = "Could not open the dashboard. Try again.";
const PAIR_FAILED_MESSAGE =
  "Could not finish connecting. Try again, or enter the pairing code shown in the tab.";

interface SessionStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

interface PendingConnect {
  tabId: number;
  origin: string;
  expiresAt: number;
}

export interface OneClickStartDeps {
  permissions: { request(p: { origins: string[] }): Promise<boolean> };
  tabs: { create(p: { url: string }): Promise<{ id?: number }> };
  session: SessionStorage;
  now(): number;
}

/**
 * The popup's "Connect" without a code. Like `connect`, the permission request is the first thing
 * it does, synchronously (Firefox only prompts inside a user gesture). Rejects with a
 * `ConnectError` when the URL is refused, the permission is denied or the tab cannot be opened.
 */
export async function startOneClick(serverUrl: string, deps: OneClickStartDeps): Promise<void> {
  const { origin, originPattern } = normalizeServerUrl(serverUrl);

  let granted: boolean;
  try {
    granted = await deps.permissions.request({ origins: [originPattern] });
  } catch {
    granted = false;
  }
  if (!granted) throw new ConnectError("permission_denied", PERMISSION_DENIED_MESSAGE);

  await deps.session.remove(ONE_CLICK_ERROR_STORAGE_KEY);
  let tabId: number | undefined;
  try {
    tabId = (await deps.tabs.create({ url: `${origin}${CONNECT_PATH}` })).id;
  } catch {
    tabId = undefined;
  }
  if (tabId === undefined) throw new ConnectError("network", TAB_FAILED_MESSAGE);
  const value: PendingConnect = { tabId, origin, expiresAt: deps.now() + ONE_CLICK_TTL_MS };
  await deps.session.set({ [ONE_CLICK_STORAGE_KEY]: value });
}

/**
 * The pairing code in `url`, or null unless `url` is exactly `<origin>/connect-extension/done`
 * with a `#code=` fragment of the right shape. `origin` is a canonical origin
 * (`normalizeServerUrl`); credentials, another port, scheme, host or path all give null.
 */
export function readPairingCodeFromUrl(url: string, origin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== origin || parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.pathname !== CONNECT_DONE_PATH || parsed.search !== "") return null;
  const code = new URLSearchParams(parsed.hash.slice(1)).get("code");
  return code !== null && CODE_PATTERN.test(code) ? code : null;
}

function parsePending(value: unknown): PendingConnect | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { tabId, origin, expiresAt } = value as Record<string, unknown>;
  if (!Number.isInteger(tabId) || typeof origin !== "string" || !Number.isFinite(expiresAt)) {
    return null;
  }
  try {
    if (normalizeServerUrl(origin).origin !== origin) return null;
  } catch {
    return null;
  }
  return { tabId: tabId as number, origin, expiresAt: expiresAt as number };
}

export interface OneClickHandlerDeps {
  session: SessionStorage;
  tabs: { remove(tabId: number): Promise<void> };
  /** Redeems the code and stores the connection (`pairWithCode` with the background's deps). */
  pair(origin: string, pairingCode: string): Promise<Connection>;
  now(): number;
}

export interface OneClickHandler {
  onTabUpdated(
    tabId: number,
    changeInfo: { url?: string; status?: string },
    tab?: { url?: string },
  ): Promise<void>;
  onTabRemoved(tabId: number): Promise<void>;
}

/**
 * The background side. Both methods resolve to undefined and never reject. Calls are run one at a
 * time, so a tab that reports the same URL twice (url change, then status complete) is redeemed
 * once: the pending connect is removed before the code is sent.
 */
export function createOneClickHandler(deps: OneClickHandlerDeps): OneClickHandler {
  let queue: Promise<void> = Promise.resolve();
  const serial = (work: () => Promise<void>): Promise<void> => {
    const next = queue.then(work).catch(() => undefined);
    queue = next;
    return next;
  };

  async function readPending(): Promise<PendingConnect | null> {
    const stored = await deps.session.get(ONE_CLICK_STORAGE_KEY);
    const pending = parsePending(stored[ONE_CLICK_STORAGE_KEY]);
    if (pending !== null && pending.expiresAt < deps.now()) {
      await deps.session.remove(ONE_CLICK_STORAGE_KEY);
      return null;
    }
    return pending;
  }

  return {
    onTabUpdated(tabId, changeInfo, tab) {
      const url = changeInfo.url ?? (changeInfo.status === "complete" ? tab?.url : undefined);
      // Every navigation of every tab comes through here: skip storage unless it can be the page.
      if (typeof url !== "string" || !url.includes(CONNECT_DONE_PATH)) return Promise.resolve();
      return serial(async () => {
        const pending = await readPending();
        if (pending === null || pending.tabId !== tabId) return;
        const code = readPairingCodeFromUrl(url, pending.origin);
        if (code === null) return;
        await deps.session.remove(ONE_CLICK_STORAGE_KEY);
        try {
          await deps.pair(pending.origin, code);
        } catch (error) {
          // Only a fixed message: a ConnectError's own text, never the code or a server body.
          const message = error instanceof ConnectError ? error.message : PAIR_FAILED_MESSAGE;
          await deps.session.set({ [ONE_CLICK_ERROR_STORAGE_KEY]: message });
          return;
        }
        await deps.tabs.remove(tabId).catch(() => undefined);
      });
    },
    onTabRemoved(tabId) {
      return serial(async () => {
        const pending = await readPending();
        if (pending !== null && pending.tabId === tabId) {
          await deps.session.remove(ONE_CLICK_STORAGE_KEY);
        }
      });
    },
  };
}
