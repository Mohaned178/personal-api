// M4-06 the popup's verdict for the current tab.

import { describe, expect, it } from "vitest";
import { currentTabVerdict, describeVerdict } from "../../lib/rules/verdict";
import { active, configOf, domainRule } from "./support";

const github = domainRule("Track GitHub", "github.com", "allow");
const bank = domainRule("No banking", "bank.example", "drop", { priority: 1 });
const rules = active(configOf([github, bank]));
const tab = (url: string | undefined, incognito: boolean | undefined = false) => ({
  url,
  incognito,
});

describe("currentTabVerdict", () => {
  it("is collected, naming the allowing rule", () => {
    expect(currentTabVerdict(tab("https://github.com/org/repo?token=1#x"), rules)).toEqual({
      kind: "collected",
      reason: { by: "rule", ruleName: "Track GitHub" },
    });
  });

  it("is blocked, naming the dropping rule", () => {
    expect(currentTabVerdict(tab("https://bank.example/account"), rules)).toEqual({
      kind: "blocked",
      reason: { by: "rule", ruleName: "No banking" },
    });
  });

  it("is blocked by the default policy when no rule decides", () => {
    expect(currentTabVerdict(tab("https://other.example/"), rules)).toEqual({
      kind: "blocked",
      reason: { by: "default_policy" },
    });
  });

  it("is collected by the default policy under allow", () => {
    const open = active(configOf([], { version: 0, defaultPolicy: "allow" }));
    expect(currentTabVerdict(tab("https://other.example/"), open)).toEqual({
      kind: "collected",
      reason: { by: "default_policy" },
    });
  });

  it("is no_rules without valid rules", () => {
    expect(currentTabVerdict(tab("https://github.com/"), null)).toEqual({ kind: "no_rules" });
  });

  it.each([
    ["no tab", undefined],
    ["a browser page", tab("about:preferences")],
    ["an extension page", tab("moz-extension://abc/popup.html")],
    ["a file", tab("file:///etc/hosts")],
    ["no url", tab(undefined)],
  ])("is unsupported for %s", (_label, input) => {
    expect(currentTabVerdict(input, rules)).toEqual({ kind: "unsupported" });
  });

  it.each([
    ["a private tab", tab("https://github.com/", true)],
    ["an unknown incognito flag", { url: "https://github.com/" }],
  ])("is private for %s, whatever the rules say", (_label, input) => {
    expect(currentTabVerdict(input, rules)).toEqual({ kind: "private" });
  });
});

describe("describeVerdict", () => {
  it("names the rule and never shows a URL or domain", () => {
    const text = describeVerdict(
      currentTabVerdict(tab("https://bank.example/secret-path"), rules),
      true,
    );
    expect(text).toBe('Not collected, blocked by "No banking".');
    expect(text).not.toContain("secret-path");
  });

  it("says nothing is collected while paused or disconnected, whatever the verdict", () => {
    const verdict = currentTabVerdict(tab("https://github.com/"), rules);
    expect(describeVerdict(verdict, false)).toBe("Nothing is collected right now.");
  });

  it.each([
    [{ kind: "unsupported" }, "This page is never collected."],
    [{ kind: "private" }, "Private windows are never collected."],
    [{ kind: "no_rules" }, "No rules loaded yet, so nothing is collected."],
    [{ kind: "error" }, "The rules could not be applied, so nothing is collected."],
    [{ kind: "collected", reason: { by: "default_policy" } }, "Collected, by your default policy."],
    [{ kind: "blocked", reason: { by: "default_policy" } }, "Not collected, no rule allows it."],
  ] as const)("describes %j", (verdict, text) => {
    expect(describeVerdict(verdict, true)).toBe(text);
  });
});
