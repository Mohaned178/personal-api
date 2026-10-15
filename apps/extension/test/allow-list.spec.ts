// M2-07 temporary allow list: deny by default, fail closed, exact hostname match.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ALLOW_LIST_STORAGE_KEY,
  addAllowedDomain,
  createAllowListGate,
  getAllowList,
  isDomainAllowed,
  MAX_ALLOW_LIST_ENTRIES,
  normalizeAllowedDomain,
  removeAllowedDomain,
} from "../lib/allow-list";

function memory(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (key: string) => ({ [key]: data[key] }),
    set: async (items: Record<string, unknown>) => void Object.assign(data, items),
  };
}
const broken = {
  get: async (): Promise<Record<string, unknown>> => {
    throw new Error("boom");
  },
  set: async (): Promise<void> => {
    throw new Error("boom");
  },
};

describe("normalizeAllowedDomain", () => {
  it("lowercases, trims and drops one trailing dot", () => {
    expect(normalizeAllowedDomain("  Example.COM. ")).toBe("example.com");
  });
  it.each([
    "",
    " ",
    "https://example.com",
    "example.com/path",
    "example.com:8080",
    "*.example.com",
    "user@example.com",
    "exa mple.com",
    "a..b",
    "-bad.example",
    "?x=1",
    "#f",
  ])("rejects %j", (bad) => {
    expect(normalizeAllowedDomain(bad)).toBeNull();
  });
  it("rejects non-strings and over-long names", () => {
    expect(normalizeAllowedDomain(undefined)).toBeNull();
    expect(normalizeAllowedDomain(42)).toBeNull();
    expect(normalizeAllowedDomain(`${"a".repeat(250)}.com`)).toBeNull();
  });
});

describe("persistence", () => {
  it("is empty by default", async () => {
    expect(await getAllowList(memory())).toEqual([]);
  });
  it("add stores a normalized entry under the storage key and list returns it", async () => {
    const s = memory();
    expect(await addAllowedDomain(s, "Example.com")).toEqual(["example.com"]);
    expect(s.data[ALLOW_LIST_STORAGE_KEY]).toEqual(["example.com"]);
    expect(await getAllowList(s)).toEqual(["example.com"]);
  });
  it("add de-duplicates case-insensitively", async () => {
    const s = memory();
    await addAllowedDomain(s, "a.example");
    expect(await addAllowedDomain(s, "A.EXAMPLE.")).toEqual(["a.example"]);
  });
  it("add rejects an invalid domain and stores nothing", async () => {
    const s = memory();
    await expect(addAllowedDomain(s, "https://x.example/a")).rejects.toThrow();
    expect(s.data[ALLOW_LIST_STORAGE_KEY]).toBeUndefined();
  });
  it("add rejects beyond the cap", async () => {
    const full = Array.from({ length: MAX_ALLOW_LIST_ENTRIES }, (_, i) => `h${i}.example`);
    const s = memory({ [ALLOW_LIST_STORAGE_KEY]: full });
    await expect(addAllowedDomain(s, "extra.example")).rejects.toThrow();
    expect(await getAllowList(s)).toEqual(full);
  });
  it("remove deletes one entry and tolerates an absent one", async () => {
    const s = memory();
    await addAllowedDomain(s, "a.example");
    await addAllowedDomain(s, "b.example");
    expect(await removeAllowedDomain(s, "A.example")).toEqual(["b.example"]);
    expect(await removeAllowedDomain(s, "zzz.example")).toEqual(["b.example"]);
  });
  it("a failing write propagates and leaves the list unchanged", async () => {
    const s = memory({ [ALLOW_LIST_STORAGE_KEY]: ["a.example"] });
    s.set = async () => {
      throw new Error("quota");
    };
    await expect(addAllowedDomain(s, "b.example")).rejects.toThrow();
    expect(await getAllowList(s)).toEqual(["a.example"]);
  });
});

describe("fail closed on bad storage", () => {
  it.each([
    ["a string", "example.com"],
    ["an object", { "example.com": true }],
    ["a number", 1],
    ["null", null],
    ["an array with a non-string", ["a.example", 5]],
    ["an array with an invalid entry", ["a.example", "https://b.example"]],
    ["an un-normalized entry", ["Example.com"]],
  ])("treats %s as an empty list", async (_n, value) => {
    expect(await getAllowList(memory({ [ALLOW_LIST_STORAGE_KEY]: value }))).toEqual([]);
  });
  it("treats a throwing read as an empty list", async () => {
    expect(await getAllowList(broken)).toEqual([]);
  });
});

describe("isDomainAllowed (exact hostname only)", () => {
  const list = ["example.com", "sub.other.org"];
  it("matches exactly, case-insensitively", () => {
    expect(isDomainAllowed(list, "example.com")).toBe(true);
    expect(isDomainAllowed(list, "EXAMPLE.com")).toBe(true);
  });
  it("does not match subdomains, parents, suffixes or lookalikes", () => {
    expect(isDomainAllowed(list, "www.example.com")).toBe(false);
    expect(isDomainAllowed(list, "other.org")).toBe(false);
    expect(isDomainAllowed(list, "com")).toBe(false);
    expect(isDomainAllowed(list, "notexample.com")).toBe(false);
    expect(isDomainAllowed(list, "example.com.evil.net")).toBe(false);
  });
  it("an empty list allows nothing", () => {
    expect(isDomainAllowed([], "example.com")).toBe(false);
  });
  it("property: allowed iff the domain is in the list", () => {
    const host = fc.stringMatching(/^[a-z0-9]{1,8}(\.[a-z0-9]{1,8}){0,2}$/);
    fc.assert(
      fc.property(fc.array(host, { maxLength: 5 }), host, (l, d) => {
        expect(isDomainAllowed(l, d)).toBe(l.includes(d));
      }),
    );
  });
});

describe("createAllowListGate", () => {
  const page = (domain: string) => ({ domain, path: "/" });
  it("denies everything when nothing is stored", async () => {
    expect(await createAllowListGate(memory()).allows(page("example.com"))).toBe(false);
  });
  it("allows a listed domain and denies others", async () => {
    const gate = createAllowListGate(memory({ [ALLOW_LIST_STORAGE_KEY]: ["example.com"] }));
    expect(await gate.allows(page("example.com"))).toBe(true);
    expect(await gate.allows(page("www.example.com"))).toBe(false);
    expect(await gate.allows(page("other.com"))).toBe(false);
  });
  it("denies a null page even when the list is non-empty", async () => {
    const gate = createAllowListGate(memory({ [ALLOW_LIST_STORAGE_KEY]: ["example.com"] }));
    expect(await gate.allows(null)).toBe(false);
  });
  it("reads fresh on every call (add and remove take effect immediately)", async () => {
    const s = memory();
    const gate = createAllowListGate(s);
    await addAllowedDomain(s, "example.com");
    expect(await gate.allows(page("example.com"))).toBe(true);
    await removeAllowedDomain(s, "example.com");
    expect(await gate.allows(page("example.com"))).toBe(false);
  });
  it("denies on garbage storage and on a throwing read", async () => {
    const bad = memory({ [ALLOW_LIST_STORAGE_KEY]: "example.com" });
    expect(await createAllowListGate(bad).allows(page("example.com"))).toBe(false);
    expect(await createAllowListGate(broken).allows(page("example.com"))).toBe(false);
  });
});
