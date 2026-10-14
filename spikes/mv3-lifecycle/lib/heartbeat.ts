// Pure part of the spike's manual-only heartbeat switch (docs/spikes/mv3-lifecycle-manual-protocol.md).
// The 30 s heartbeat alarm resets Chrome's ~30 s service-worker idle timer, so with it on the
// worker is usually already running when an idle, lock or focus event arrives. The manual protocol
// turns it off for M1-M3 to make those events wake a stopped worker. No chrome or I/O here.

/** chrome.storage.local key of the persisted switch. Missing means on (the default behaviour). */
export const HEARTBEAT_FLAG_KEY = "spike.heartbeatEnabled";

/** The persisted value as a switch: only an explicit `false` turns the heartbeat off. */
export const isHeartbeatEnabled = (stored: unknown): boolean => stored !== false;

export type HeartbeatAlarmAction = "create" | "clear" | "keep";

/**
 * What to do with the heartbeat alarm on a worker start or a switch change. An existing alarm is
 * kept when the heartbeat is on, so frequent worker restarts do not keep pushing the next tick back.
 */
export function heartbeatAlarmAction(enabled: boolean, alarmExists: boolean): HeartbeatAlarmAction {
  if (enabled) return alarmExists ? "keep" : "create";
  return alarmExists ? "clear" : "keep";
}
