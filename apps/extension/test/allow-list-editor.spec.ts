// Temporary popup allow list editor logic (replaced by M4-06).
import { describe, expect, it } from "vitest";
import {
  addDomainFromInput,
  INVALID_DOMAIN_MESSAGE,
  loadAllowListEditor,
  removeDomain,
  SAVE_FAILED_MESSAGE,
} from "../lib/allow-list-editor";

function memory(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (key: string) => ({ [key]: data[key] }),
    set: async (items: Record<string, unknown>) => void Object.assign(data, items),
  };
}

describe("allow list editor", () => {
  it("loads an empty list by default", async () => {
    expect(await loadAllowListEditor(memory())).toEqual({ domains: [], error: null });
  });

  it("adds a valid domain, normalized", async () => {
    const storage = memory();
    expect(await addDomainFromInput(storage, "  Example.COM. ")).toEqual({
      domains: ["example.com"],
      error: null,
    });
    expect((await loadAllowListEditor(storage)).domains).toEqual(["example.com"]);
  });

  it("rejects invalid input with an inline error and stores nothing", async () => {
    const storage = memory();
    for (const bad of ["", "https://example.com/a", "a b", "*.example.com", "example.com:8080"]) {
      const state = await addDomainFromInput(storage, bad);
      expect(state).toEqual({ domains: [], error: INVALID_DOMAIN_MESSAGE });
      expect(state.error).not.toContain(bad || "\u0000");
    }
    expect(storage.data).toEqual({});
  });

  it("de-duplicates", async () => {
    const storage = memory();
    await addDomainFromInput(storage, "example.com");
    const state = await addDomainFromInput(storage, "EXAMPLE.com");
    expect(state.domains).toEqual(["example.com"]);
  });

  it("removes a domain and ignores an absent one", async () => {
    const storage = memory();
    await addDomainFromInput(storage, "a.com");
    await addDomainFromInput(storage, "b.com");
    expect((await removeDomain(storage, "a.com")).domains).toEqual(["b.com"]);
    expect((await removeDomain(storage, "zzz.com")).domains).toEqual(["b.com"]);
  });

  it("reports a storage write failure without throwing", async () => {
    const storage = {
      get: async () => ({}),
      set: async () => {
        throw new Error("boom");
      },
    };
    expect(await addDomainFromInput(storage, "a.com")).toEqual({
      domains: [],
      error: SAVE_FAILED_MESSAGE,
    });
  });
});
