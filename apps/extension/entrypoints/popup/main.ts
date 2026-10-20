// Popup wiring for the M2-02 connect flow and the M2-06 status/pause view. Logic lives in lib/.

import { browser } from "wxt/browser";
import {
  CONNECTION_STORAGE_KEY,
  type ConnectDeps,
  ConnectError,
  type Connection,
  connect,
  disconnect,
  getConnection,
} from "../../lib/connect";
import { ONE_CLICK_ERROR_STORAGE_KEY, startOneClick } from "../../lib/one-click";
import { setPaused } from "../../lib/pause";
import {
  clearLocalQueue,
  loadPopupState,
  type PopupState,
  type PopupStatus,
} from "../../lib/popup-state";
import { createFlusher, createIdbCaptureStore } from "../../lib/queue";
import { readActiveRules } from "../../lib/rules/active-rules";
import { createRulesSync } from "../../lib/rules/sync";
import { currentTabVerdict, describeVerdict } from "../../lib/rules/verdict";

// The popup reads the same IndexedDB database the background writes: a store for the counters and
// a flusher used for `getSyncStatus` and the "Clear local queue" action. Never the ingest key
// (invariant: the popup never shows it).
const store = createIdbCaptureStore({ now: Date.now });
const deps: ConnectDeps = {
  permissions: browser.permissions,
  storage: browser.storage.local,
  fetch: (url, init) => fetch(url, init),
  queue: store,
  // Right after pairing, fetch the rules so capture can start without waiting for the alarm.
  syncRules: () => rulesSync.sync(),
};
const rulesSync = createRulesSync({
  getConnection: () => getConnection(deps),
  storage: browser.storage.local,
  fetch: deps.fetch,
  alarms: browser.alarms,
});
const flusher = createFlusher({
  store,
  getConnection: () => getConnection(deps),
  fetch: deps.fetch,
  alarms: browser.alarms,
  now: Date.now,
  random: Math.random,
});
const stateDeps = {
  getConnection: () => getConnection(deps),
  flusher,
  store,
  storage: browser.storage.local,
};

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Popup markup is missing #${id}`);
  }
  return element as T;
}

const connectedView = byId<HTMLElement>("connected-view");
const connectedOrigin = byId<HTMLElement>("connected-origin");
const connectedName = byId<HTMLElement>("connected-name");
const disconnectButton = byId<HTMLButtonElement>("disconnect");
const openTabView = byId<HTMLElement>("open-tab-view");
const openTabButton = byId<HTMLButtonElement>("open-tab");
const connectForm = byId<HTMLFormElement>("connect-form");
const serverUrlInput = byId<HTMLInputElement>("server-url");
const pairingCodeInput = byId<HTMLInputElement>("pairing-code");
const connectButton = byId<HTMLButtonElement>("connect");
const status = byId<HTMLElement>("status");
const stateStatus = byId<HTMLElement>("state-status");
const stateQueueDepth = byId<HTMLElement>("state-queue-depth");
const stateLastSync = byId<HTMLElement>("state-last-sync");
const stateDropped = byId<HTMLElement>("state-dropped");
const pauseToggle = byId<HTMLButtonElement>("pause-toggle");
const clearQueueButton = byId<HTMLButtonElement>("clear-queue");

function setStatus(message: string, isError = false): void {
  status.textContent = message;
  status.dataset.error = isError ? "true" : "false";
}

// ---------------------------------------------------------------------------------------------
// M2-06 status and pause

const STATUS_LABELS: Record<PopupStatus, string> = {
  not_connected: "Not connected",
  disconnected: "Disconnected",
  paused: "Paused",
  collecting: "Collecting",
};

let state: PopupState | null = null;

function renderState(next: PopupState): void {
  state = next;
  stateStatus.textContent = STATUS_LABELS[next.status];
  stateQueueDepth.textContent = String(next.queueDepth);
  stateLastSync.textContent =
    next.lastSyncAt === null ? "Never" : new Date(next.lastSyncAt).toLocaleString();
  stateDropped.textContent = String(next.droppedCount);
  pauseToggle.hidden = next.connection === "not_connected";
  pauseToggle.textContent = next.paused ? "Resume" : "Pause";
  clearQueueButton.hidden = !next.canClearQueue;
}

/** Re-reads the snapshot. `loadPopupState` never rejects. */
function refreshState(): Promise<void> {
  return loadPopupState(stateDeps)
    .then(renderState)
    .then(() => refreshTabVerdict());
}

pauseToggle.addEventListener("click", () => {
  if (state === null) return;
  pauseToggle.disabled = true;
  void setPaused(browser.storage.local, !state.paused)
    .then(refreshState, () => undefined)
    .then(() => {
      pauseToggle.disabled = false;
    });
});

clearQueueButton.addEventListener("click", () => {
  clearQueueButton.disabled = true;
  void clearLocalQueue(stateDeps).then((next) => {
    renderState(next);
    clearQueueButton.disabled = false;
  });
});

// -----------------------------------------------------------------------------------------------
// M4-06 "this page": the current tab's verdict, from the same engine and rules as capture. Never
// shows or logs the URL. Not shown on the connect page opened in a tab (the active tab is this page).

const tabVerdictView = byId<HTMLElement>("tab-verdict-view");
const tabVerdict = byId<HTMLElement>("tab-verdict");

async function refreshTabVerdict(): Promise<void> {
  if (inTab || state === null) {
    tabVerdictView.hidden = true;
    return;
  }
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const active = await readActiveRules(browser.storage.local);
    tabVerdict.textContent = describeVerdict(
      currentTabVerdict(tab, active),
      state.status === "collecting",
    );
    tabVerdictView.hidden = false;
  } catch {
    tabVerdictView.hidden = true;
  }
}

// ---------------------------------------------------------------------------------------------
// M2-02 connect flow

// Firefox may close the toolbar popup when the permission prompt opens, which would kill the
// connect flow before fetch and storage run. So the toolbar popup only links to this same page in
// a tab (`?tab=1`), and the connect form runs there. The page also counts as "in a tab" when it was
// opened in one directly.
const TAB_QUERY = "tab";
let inTab = new URLSearchParams(window.location.search).get(TAB_QUERY) === "1";

function render(connection: Connection | null): void {
  connectedView.hidden = connection === null;
  connectForm.hidden = connection !== null || !inTab;
  openTabView.hidden = connection !== null || inTab;
  if (connection !== null) {
    connectedOrigin.textContent = connection.serverOrigin;
    connectedName.textContent = connection.integrationName;
  }
}

connectForm.addEventListener("submit", (event) => {
  event.preventDefault();
  // No code: one-click connect (M8-01). The dashboard opens in a tab; the background pairs and
  // closes it, and the storage listener below shows the result here. Like connect(), it requests
  // the permission synchronously, inside the user gesture.
  if (pairingCodeInput.value.trim() === "") {
    const started = startOneClick(serverUrlInput.value, {
      permissions: browser.permissions,
      tabs: browser.tabs,
      session: browser.storage.session,
      now: Date.now,
    });
    connectButton.disabled = true;
    setStatus("Opening the dashboard…");
    void started.then(
      () => {
        connectButton.disabled = false;
        setStatus("Confirm in the dashboard tab. This page updates when you are connected.");
      },
      (error: unknown) => {
        connectButton.disabled = false;
        setStatus(error instanceof ConnectError ? error.message : "Something went wrong.", true);
      },
    );
    return;
  }
  // connect() must run inside the user gesture (Firefox) so nothing may await before the call:
  // it calls browser.permissions.request synchronously.
  const pending = connect(
    { serverUrl: serverUrlInput.value, pairingCode: pairingCodeInput.value },
    deps,
  );
  connectButton.disabled = true;
  setStatus("Connecting…");
  void pending.then(
    (connection) => {
      pairingCodeInput.value = "";
      connectButton.disabled = false;
      render(connection);
      setStatus("Connected.");
      void refreshState();
    },
    (error: unknown) => {
      connectButton.disabled = false;
      setStatus(error instanceof ConnectError ? error.message : "Something went wrong.", true);
    },
  );
});

openTabButton.addEventListener("click", () => {
  openTabButton.disabled = true;
  void browser.tabs.create({ url: browser.runtime.getURL("/popup.html?tab=1") }).then(
    () => {
      window.close();
    },
    () => {
      openTabButton.disabled = false;
      setStatus("Could not open the connect page. Try again.", true);
    },
  );
});

disconnectButton.addEventListener("click", () => {
  disconnectButton.disabled = true;
  void disconnect(deps).then(
    () => {
      disconnectButton.disabled = false;
      render(null);
      setStatus("Disconnected.");
      void refreshState();
    },
    () => {
      disconnectButton.disabled = false;
      setStatus("Could not disconnect. Try again.", true);
    },
  );
});

/** True when this page is a normal tab (tabs.getCurrent resolves undefined in the toolbar popup). */
async function isInTab(): Promise<boolean> {
  try {
    return (await browser.tabs.getCurrent()) !== undefined;
  } catch {
    return false;
  }
}

// One-click connect finishes in the background: show the new connection, or its failure message.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && CONNECTION_STORAGE_KEY in changes) {
    void getConnection(deps).then((connection) => {
      render(connection);
      if (connection !== null) setStatus("Connected.");
      void refreshState();
    });
  }
  if (area === "session" && ONE_CLICK_ERROR_STORAGE_KEY in changes) {
    const message = changes[ONE_CLICK_ERROR_STORAGE_KEY]?.newValue;
    if (typeof message === "string") setStatus(message, true);
  }
});

void Promise.all([getConnection(deps), isInTab()]).then(([connection, tab]) => {
  inTab = inTab || tab;
  render(connection);
  setStatus(connection === null ? "" : "Connected.");
  void refreshState();
});
