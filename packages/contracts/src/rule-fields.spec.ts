import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { PAGE_TRANSITIONS, SESSION_END_REASONS, SESSION_START_REASONS } from "./browser-events.js";
import { EVENT_TYPES, eventTypeRegistry } from "./registry.js";
import {
  getRuleFields,
  NOT_CONDITIONABLE_FIELDS,
  opsForKind,
  RULE_FIELD_KINDS,
  RULE_OPS,
  ruleFieldRegistry,
} from "./rule-fields.js";
import { ruleConditionSchema } from "./rules.js";

describe("rule field registry", () => {
  it("has an entry for every registered event type and no others", () => {
    expect(Object.keys(ruleFieldRegistry).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it("covers every field of every event data schema (a new field must be classified)", () => {
    for (const [key, schema] of Object.entries(eventTypeRegistry)) {
      const type = key.slice(0, key.lastIndexOf("@"));
      const shape = Object.keys((schema as unknown as z.ZodObject).shape);
      const conditionable = Object.keys(getRuleFields(type) ?? {}).map((f) =>
        f.replace(/^data\./, ""),
      );
      const excluded = Object.keys(
        (NOT_CONDITIONABLE_FIELDS as Record<string, Record<string, string>>)[type] ?? {},
      );
      expect([...conditionable, ...excluded].sort(), type).toEqual([...shape].sort());
    }
  });

  it("marks a field optional exactly when its data schema allows it to be missing", () => {
    for (const [key, schema] of Object.entries(eventTypeRegistry)) {
      const type = key.slice(0, key.lastIndexOf("@"));
      const shape = (schema as unknown as z.ZodObject).shape;
      for (const [field, spec] of Object.entries(getRuleFields(type) ?? {})) {
        const name = field.replace(/^data\./, "");
        expect(spec.optional, `${type} ${field}`).toBe(shape[name].safeParse(undefined).success);
      }
    }
  });

  it("takes enum values from the event schemas, not a copy", () => {
    expect(getRuleFields("browser.page_visited")?.["data.transition"]).toMatchObject({
      kind: "enum",
      values: PAGE_TRANSITIONS,
    });
    expect(getRuleFields("browser.session_started")?.["data.reason"]).toMatchObject({
      values: SESSION_START_REASONS,
    });
    expect(getRuleFields("browser.session_ended")?.["data.reason"]).toMatchObject({
      values: SESSION_END_REASONS,
    });
  });

  it("every kind allows `exists`, and nothing allows an op outside RULE_OPS", () => {
    for (const kind of RULE_FIELD_KINDS) {
      const ops = opsForKind(kind);
      expect(ops).toContain("exists");
      for (const op of ops) expect(RULE_OPS).toContain(op);
    }
  });

  it("restricts ops by kind", () => {
    expect(opsForKind("path")).not.toContain("domain_matches");
    expect(opsForKind("path")).not.toContain("gt");
    expect(opsForKind("enum")).not.toContain("starts_with");
    expect(opsForKind("domain")).toContain("domain_matches");
    expect(opsForKind("int")).toEqual(expect.arrayContaining(["gt", "lt", "eq", "neq"]));
    expect(opsForKind("timestamp")).toEqual(expect.arrayContaining(["gt", "lt"]));
    expect(opsForKind("timestamp")).not.toContain("contains");
  });

  it("returns undefined for an unknown type, including prototype keys", () => {
    expect(getRuleFields("browser.nope")).toBeUndefined();
    expect(getRuleFields("__proto__")).toBeUndefined();
    expect(getRuleFields("constructor")).toBeUndefined();
  });
});

describe("rule conditions", () => {
  it("has one condition schema per op in RULE_OPS", () => {
    const ops = ruleConditionSchema.options.map((option) => option.shape.op.value);
    expect([...ops].sort()).toEqual([...RULE_OPS].sort());
  });
});
