// M9-02 the open focus segment, for the limits. A read: the transaction returns the state unchanged.

import type { CaptureStore } from "../capture";
import { openUse, unchanged } from "../capture/state";
import type { OpenUse } from "./evaluate";

/** Local midnight at the start of the day `ms` falls in. */
export function localDayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** How long the page in focus has been open today, or null. Rejects only when the store does. */
export async function readOpenUse(store: CaptureStore, now: number): Promise<OpenUse | null> {
  let use: OpenUse | null = null;
  await store.transact((prev) => {
    use = openUse(prev, now, localDayStart(now));
    return unchanged(prev);
  });
  return use;
}
