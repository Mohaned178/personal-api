// M4-06 the page-level rule gate (the first of two layers; see `applyRules` for the second).
//
// The capture engine asks "may this page be collected?" before it writes anything about the page
// into its IndexedDB state, so a denied page never leaves a trace there. Rules decide on events,
// so the question is answered with probe events: a page may be collected when the user's rules
// would collect at least one kind of event about it. This only keeps state out; each real event is
// still decided by `applyRules` inside the commit, which is the authority (it applies redact and
// coarsen, sees the real duration and stamps the version).
//
// Limit: a probe has fixed values for what a real event only has later. A rule that allows a
// `focus_segment` only for durations the probes do not cover keeps that page out of state, so it
// collects less than the rule says, never more.

import { FOCUS_SEGMENT_MAX_MS, type KnownEvent } from "@personal-api/contracts";
import { evaluate } from "@personal-api/rules";
import type { CaptureGate } from "../capture";
import type { SanitizedUrl } from "../sanitize-url";
import { type ActiveRules, type RulesStorage, readActiveRules } from "./active-rules";

const PROBE_ID = "00000000-0000-7000-8000-000000000000";
const PROBE_TAB_REF = "probe-tab-ref";
const PROBE_AT = "2026-01-01T00:00:00.000Z";

/** Durations a `focus_segment` probe tries, so a rule on `data.durationMs` is likely to be met. */
const PROBE_DURATIONS_MS = [1, 60_000, FOCUS_SEGMENT_MAX_MS];

function probe(type: KnownEvent["type"], data: Record<string, unknown>): KnownEvent {
  return { id: PROBE_ID, type, typeVersion: 1, occurredAt: PROBE_AT, data } as KnownEvent;
}

/** The events the engine could emit for a page, or, with no page, for the events that carry none. */
export function probeEvents(page: SanitizedUrl | null): KnownEvent[] {
  if (page === null) {
    return [
      probe("browser.tab_opened", { tabRef: PROBE_TAB_REF }),
      probe("browser.tab_closed", { tabRef: PROBE_TAB_REF }),
      probe("browser.session_started", { reason: "startup" }),
      probe("browser.session_ended", { reason: "idle" }),
    ];
  }
  const { domain, path } = page;
  return [
    probe("browser.page_visited", { domain, path, tabRef: PROBE_TAB_REF }),
    probe("browser.tab_opened", { domain, tabRef: PROBE_TAB_REF }),
    ...PROBE_DURATIONS_MS.map((durationMs) =>
      probe("browser.focus_segment", {
        domain,
        path,
        startedAt: PROBE_AT,
        endedAt: new Date(Date.parse(PROBE_AT) + durationMs).toISOString(),
        durationMs,
      }),
    ),
  ];
}

/** True only when the rules would collect at least one probe event. Never throws. */
export function mayCollect(active: ActiveRules, page: SanitizedUrl | null): boolean {
  try {
    return probeEvents(page).some(
      (event) =>
        evaluate(event, active.ruleSet, active.defaultPolicy, {
          source: "browser-extension",
          process: false,
        }).decision === "allow",
    );
  } catch {
    return false;
  }
}

/**
 * The capture gate backed by the stored rules. `storage` is read on every call (one `get`), so a
 * rule change or a removed connection applies to the next navigation. No rules, rules of another
 * connection, or any failure: deny (invariant 1).
 */
export function createRulesGate(storage: RulesStorage): CaptureGate {
  return {
    async allows(page) {
      try {
        const active = await readActiveRules(storage);
        return active !== null && mayCollect(active, page);
      } catch {
        return false;
      }
    },
  };
}
