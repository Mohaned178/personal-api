import { describe, expect, it } from "vitest";
import {
  draftToRule,
  emptyDraft,
  fieldKind,
  REDACTABLE_FIELDS,
  ruleToDraft,
  validateRule,
} from "./rule-draft";

const valid = {
  name: "Track GitHub, but not settings pages",
  enabled: true,
  priority: 10,
  stage: "collect",
  when: {
    source: ["browser-extension"],
    type: ["browser.*"],
    all: [{ field: "data.domain", op: "domain_matches", value: "github.com" }],
    none: [{ field: "data.path", op: "starts_with", value: "/settings" }],
  },
  then: [{ action: "allow" }],
} as const;

describe("rule draft", () => {
  it("round-trips a valid rule through the form", () => {
    const result = validateRule(valid);
    if (!result.ok) throw new Error("fixture must be valid");
    expect(draftToRule(ruleToDraft(result.rule))).toEqual(valid);
  });

  it("leaves out empty parts of `when`", () => {
    const draft = { ...emptyDraft(), name: "All" };
    expect(draftToRule(draft)).toEqual({
      name: "All",
      enabled: true,
      priority: 100,
      stage: "collect",
      when: {},
      then: [{ action: "allow" }],
    });
  });

  it("types condition values by field kind and op", () => {
    const draft = emptyDraft();
    draft.name = "x";
    draft.conditions.all = [
      { field: "data.durationMs", op: "gt", value: "5000" },
      { field: "data.domain", op: "in", value: "a.com, b.com" },
      { field: "data.transition", op: "exists", value: "false" },
    ];
    expect((draftToRule(draft).when as { all: unknown[] }).all).toEqual([
      { field: "data.durationMs", op: "gt", value: 5000 },
      { field: "data.domain", op: "in", value: ["a.com", "b.com"] },
      { field: "data.transition", op: "exists", value: false },
    ]);
  });

  it("builds action parameters", () => {
    const draft = emptyDraft();
    draft.name = "x";
    draft.then = [
      { action: "coarsen", param: "2" },
      { action: "redact", param: "data.transition" },
      { action: "keep_query", param: "" },
    ];
    expect(draftToRule(draft).then).toEqual([
      { action: "coarsen", segments: 2 },
      { action: "redact", field: "data.transition" },
      { action: "keep_query" },
    ]);
  });

  it("reports issues with a path and a fixed message, never the input", () => {
    const draft = emptyDraft();
    draft.name = "x";
    draft.conditions.all = [{ field: "data.domain", op: "eq", value: "Secret.EXAMPLE" }];
    const result = validateRule(draftToRule(draft));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.issues)).not.toMatch(/secret/i);
  });

  it("knows field kinds and which fields can be redacted", () => {
    expect(fieldKind("data.domain")).toBe("domain");
    expect(fieldKind("data.nope")).toBeUndefined();
    expect(REDACTABLE_FIELDS).toContain("data.transition");
    expect(REDACTABLE_FIELDS).not.toContain("data.path");
  });
});
