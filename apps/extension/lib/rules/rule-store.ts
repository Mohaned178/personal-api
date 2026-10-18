// M4-06 the second layer: every event the capture engine produces is decided by the stored rules
// inside the same commit that queues it.

import type { CaptureStore } from "../capture";
import { type ActiveRules, applyRules } from "./active-rules";

/**
 * Wraps the durable store the capture engine writes to. The rules are loaded BEFORE the
 * transaction (the commit callback must be synchronous), then `applyRules` filters and rewrites the
 * events in the callback, so an event is queued only when a rule set allowed it, already redacted
 * and coarsened and stamped with the version that decided it. The engine's state still advances
 * for a filtered event. If the rules cannot be loaded, no event is queued (invariant 1).
 */
export function createRuleStore(deps: {
  store: CaptureStore;
  loadRules(): Promise<ActiveRules | null>;
}): CaptureStore {
  return {
    async transact(compute) {
      let active: ActiveRules | null = null;
      try {
        active = await deps.loadRules();
      } catch {
        active = null;
      }
      return deps.store.transact((prev) => {
        const { state, events } = compute(prev);
        return { state, events: active === null ? [] : applyRules(active, events) };
      });
    },
  };
}
