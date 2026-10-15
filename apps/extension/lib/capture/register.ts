import { HEARTBEAT_ALARM_NAME } from "./constants";
import type { CaptureEngine, CaptureListenerApi } from "./types";

const noop = (): undefined => undefined;

/**
 * The promise a listener returns: it settles once the engine's work settled, always to undefined
 * (Firefox structured-clones it) and never rejects. Firefox keeps the event page alive while it is
 * pending (ADR 0002, Firefox difference 1); Chromium ignores it.
 */
function keepAlive(work: () => Promise<void>): Promise<void> {
  try {
    return work().then(noop, noop);
  } catch {
    return Promise.resolve();
  }
}

/**
 * Called synchronously at the top level of the background script. Registers every listener
 * before returning (nothing awaited first), each exactly once. Returns nothing.
 */
export function registerCaptureListeners(api: CaptureListenerApi, engine: CaptureEngine): void {
  api.tabs.onCreated.addListener((tab) => keepAlive(() => engine.onTabCreated(tab)));
  api.tabs.onUpdated.addListener((tabId, changeInfo, tab) =>
    keepAlive(() => engine.onTabUpdated(tabId, changeInfo, tab)),
  );
  api.tabs.onActivated.addListener((activeInfo) =>
    keepAlive(() => engine.onTabActivated(activeInfo)),
  );
  api.tabs.onRemoved.addListener((tabId, removeInfo) =>
    keepAlive(() => engine.onTabRemoved(tabId, removeInfo)),
  );
  api.windows.onFocusChanged.addListener((windowId) =>
    keepAlive(() => engine.onWindowFocusChanged(windowId)),
  );
  api.idle.onStateChanged.addListener((state) => keepAlive(() => engine.onIdleStateChanged(state)));
  api.alarms.onAlarm.addListener((alarm) =>
    alarm.name === HEARTBEAT_ALARM_NAME ? keepAlive(() => engine.onHeartbeat()) : undefined,
  );
  // Empty on purpose: they make the browser start the background at browser start and install
  // (Firefox only starts an event page at launch for a persisted onStartup listener). The
  // background runs `engine.start()` on every start anyway.
  api.runtime.onStartup.addListener(noop);
  api.runtime.onInstalled.addListener(noop);
}
