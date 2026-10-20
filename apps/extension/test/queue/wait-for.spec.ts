import { describe, expect, it } from "vitest";
import { tick, waitFor } from "./support/world";

// waitFor must give up on wall-clock time, not on a tick count: a loaded CI runner can need more
// event-loop turns than a fast laptop for the same fake-IndexedDB work (main CI flake, 2026-10-20).
describe("waitFor", () => {
  it("still resolves when the condition needs more than 2000 event-loop turns", async () => {
    let turns = 0;
    const counting = (async () => {
      while (turns < 5000) {
        turns++;
        await tick();
      }
    })();
    await expect(waitFor(() => turns >= 5000, "5000 turns")).resolves.toBeUndefined();
    await counting;
  });

  it("rejects with the label once the deadline passes", async () => {
    await expect(waitFor(() => false, "never", 50)).rejects.toThrow("timed out waiting for: never");
  });
});
