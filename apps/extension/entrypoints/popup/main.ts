// Popup wiring for the M2-02 connect flow. All logic lives in ../../lib/connect.ts.

import { browser } from "wxt/browser";
import {
  type ConnectDeps,
  ConnectError,
  type Connection,
  connect,
  disconnect,
  getConnection,
} from "../../lib/connect";

const deps: ConnectDeps = {
  permissions: browser.permissions,
  storage: browser.storage.local,
  fetch: (url, init) => fetch(url, init),
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
const connectForm = byId<HTMLFormElement>("connect-form");
const serverUrlInput = byId<HTMLInputElement>("server-url");
const pairingCodeInput = byId<HTMLInputElement>("pairing-code");
const connectButton = byId<HTMLButtonElement>("connect");
const status = byId<HTMLElement>("status");

function setStatus(message: string, isError = false): void {
  status.textContent = message;
  status.dataset.error = isError ? "true" : "false";
}

function render(connection: Connection | null): void {
  connectedView.hidden = connection === null;
  connectForm.hidden = connection !== null;
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
    },
    (error: unknown) => {
      connectButton.disabled = false;
      setStatus(error instanceof ConnectError ? error.message : "Something went wrong.", true);
    },
  );
});

disconnectButton.addEventListener("click", () => {
  disconnectButton.disabled = true;
  void disconnect(deps).then(() => {
    disconnectButton.disabled = false;
    render(null);
    setStatus("Disconnected.");
  });
});

void getConnection(deps).then((connection) => {
  render(connection);
  setStatus(connection === null ? "" : "Connected.");
});
