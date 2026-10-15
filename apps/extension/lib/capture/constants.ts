// M2-04 capture engine constants (ADR 0002). Values are part of the contract the tests rely on.

import { FOCUS_SEGMENT_MAX_MS } from "@personal-api/contracts";

/** A single focus segment is never longer than this (PLAN §4, contracts' FOCUS_SEGMENT_MAX_MS). */
export const SEGMENT_CAP_MS = FOCUS_SEGMENT_MAX_MS;

/** `idle.queryState` / `idle.setDetectionInterval` argument, in seconds (PLAN §4: idle at 60 s). */
export const IDLE_DETECTION_S = 60;

/** Name of the one heartbeat alarm. M2-05's flush handler may share it. */
export const HEARTBEAT_ALARM_NAME = "pa-heartbeat";

/** 30 s, the smallest period `alarms` allows. */
export const HEARTBEAT_PERIOD_MINUTES = 0.5;

/**
 * If more than this passed between two focus steps of the same browser session (machine sleep,
 * missed alarms), the open segment ends at the last step instead of at the current time.
 */
export const GAP_MS = 90_000;

/** A session ends once the user has been idle for this long (PLAN §4). */
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** `windows.WINDOW_ID_NONE`: no browser window has focus. */
export const WINDOW_ID_NONE = -1;
