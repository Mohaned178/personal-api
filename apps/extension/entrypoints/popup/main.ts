// Popup wiring for the M2-02 connect flow and the M2-06 status/pause view. Logic lives in lib/.

import { browser } from "wxt/browser";
import {
  type ConnectDeps,
  ConnectError,
  type Connection,
  connect,
  disconnect,
  getConnection,
} from "../../lib/connect";
import { setPaused } from "../../lib/pause";
import {
  loadPopupState,
  type PopupState,
  type PopupStateDeps,
  type PopupStatus,
} from "../../lib/popup-state";
import { createFlusher, createIdbCaptureStore } from "../../lib/queue";

const deps: ConnectDeps = {
  permissions: browser.permissions,
  storage: browser.storage.local,
  fetch: (url, init) => fetch(url, init),
};

// The popup reads the same IndexedDB database the background writes: a store for the counters and
// a flusher used only for `getSyncStatus`. Never the ingest key (invariant: the popup never shows it).
const store = createIdbCaptureStore({ now: Date.now });
const flusher = createFlusher({
  store,
  getConnection: () => getConnection(deps),
  fetch: deps.fetch,
  alarms: browser.alarms,
  now: Date.now,
  random: Math.random,
});
const stateDeps: PopupStateDeps = {
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
}

/** Re-reads the snapshot. `loadPopupState` never rejects. */
function refreshState(): Promise<void> {
  return loadPopupState(stateDeps).then(renderState);
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

void Promise.all([getConnection(deps), isInTab()]).then(([connection, tab]) => {
  inTab = inTab || tab;
  render(connection);
  setStatus(connection === null ? "" : "Connected.");
  void refreshState();
});
