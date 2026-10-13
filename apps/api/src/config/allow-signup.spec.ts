import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

// Extra keys are harmless today and keep this spec valid once auth settings become required.
const base = {
  DATABASE_URL: "postgres://app:secret@localhost:5433/personal_api",
  BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:3000",
};

// Read through a helper so this file typechecks before ALLOW_SIGNUP exists in the config schema.
const allowSignup = (value: string): unknown =>
  (loadConfig({ ...base, ALLOW_SIGNUP: value }) as unknown as { ALLOW_SIGNUP?: unknown })
    .ALLOW_SIGNUP;

describe("ALLOW_SIGNUP config (M0-07)", () => {
  it('parses the string "true" as boolean true', () => {
    expect(allowSignup("true")).toBe(true);
  });

  // z.coerce.boolean() would turn "false" into true and silently open signups.
  it('parses the string "false" as boolean false, not as truthy', () => {
    expect(allowSignup("false")).toBe(false);
  });

  it.each(["0", "no", "maybe", "", "TRUEISH"])(
    "fails closed on the unrecognized ALLOW_SIGNUP value %j (throws or yields false, never true)",
    (value) => {
      let parsed: unknown;
      try {
        parsed = allowSignup(value);
      } catch {
        return; // rejecting the value is a valid way to fail closed
      }
      expect(parsed).toBe(false);
    },
  );
});
