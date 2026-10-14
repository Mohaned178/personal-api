import { describe, expect, it } from "vitest";
import { HEARTBEAT_FLAG_KEY, heartbeatAlarmAction, isHeartbeatEnabled } from "../lib/heartbeat";

describe("heartbeat switch", () => {
  it("uses the documented storage key", () => {
    expect(HEARTBEAT_FLAG_KEY).toBe("spike.heartbeatEnabled");
  });

  it("is on by default, so an untouched profile keeps the heartbeat", () => {
    expect(isHeartbeatEnabled(undefined)).toBe(true);
  });

  it("is off only for an explicit false", () => {
    expect(isHeartbeatEnabled(false)).toBe(false);
    expect(isHeartbeatEnabled(true)).toBe(true);
    // Anything else (a corrupted or foreign value) keeps the default behaviour.
    for (const value of [null, 0, "", "false", {}]) expect(isHeartbeatEnabled(value)).toBe(true);
  });

  it.each([
    { enabled: true, alarmExists: false, action: "create" },
    // Kept, so frequent worker restarts do not push the next tick back.
    { enabled: true, alarmExists: true, action: "keep" },
    // Off survives worker restarts: an alarm left behind is cleared on the next start.
    { enabled: false, alarmExists: true, action: "clear" },
    { enabled: false, alarmExists: false, action: "keep" },
  ] as const)(
    "enabled=$enabled, alarm exists=$alarmExists -> $action",
    ({ enabled, alarmExists, action }) => {
      expect(heartbeatAlarmAction(enabled, alarmExists)).toBe(action);
    },
  );
});
