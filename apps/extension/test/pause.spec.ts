// M2-06 pause/resume persistence (lib/pause.ts).

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { getPaused, PAUSED_STORAGE_KEY, setPaused } from "../lib/pause";

function fakeStorage(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
    set: async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    },
  };
}

describe("pause flag", () => {
  it("is not paused when nothing was ever stored", async () => {
    expect(await getPaused(fakeStorage())).toBe(false);
  });

  it("pause then resume round-trips through storage", async () => {
    const storage = fakeStorage();
    await setPaused(storage, true);
    expect(storage.data[PAUSED_STORAGE_KEY]).toBe(true);
    expect(await getPaused(storage)).toBe(true);
    await setPaused(storage, false);
    expect(await getPaused(storage)).toBe(false);
  });

  it("survives a background restart (a new reader over the same storage still sees it)", async () => {
    const storage = fakeStorage();
    await setPaused(storage, true);
    const reopened = { get: storage.get };
    expect(await getPaused(reopened)).toBe(true);
  });

  it("fails closed: an unreadable storage counts as paused", async () => {
    const broken = {
      get: async () => {
        throw new Error("storage unavailable");
      },
    };
    expect(await getPaused(broken)).toBe(true);
  });

  it("fails closed: any stored value other than exactly false counts as paused", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.anything().filter((value) => value !== false && value !== undefined),
        async (junk) => {
          expect(await getPaused(fakeStorage({ [PAUSED_STORAGE_KEY]: junk }))).toBe(true);
        },
      ),
    );
  });

  it("an explicit stored false is not paused", async () => {
    expect(await getPaused(fakeStorage({ [PAUSED_STORAGE_KEY]: false }))).toBe(false);
  });

  it("setPaused only writes the pause key", async () => {
    const storage = fakeStorage({ connection: { keep: "me" } });
    await setPaused(storage, true);
    expect(Object.keys(storage.data).sort()).toEqual(["connection", PAUSED_STORAGE_KEY].sort());
    expect(storage.data.connection).toEqual({ keep: "me" });
  });
});
