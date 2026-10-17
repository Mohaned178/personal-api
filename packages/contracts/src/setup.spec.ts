import { describe, expect, it } from "vitest";
import { setupStatusResponseSchema } from "./setup.js";

describe("setupStatusResponseSchema", () => {
  it("accepts the two booleans", () => {
    expect(setupStatusResponseSchema.parse({ needsSetup: true, signupOpen: false })).toEqual({
      needsSetup: true,
      signupOpen: false,
    });
  });

  it.each([
    ["a missing field", { needsSetup: true }],
    ["a string flag", { needsSetup: "true", signupOpen: false }],
    ["an extra field", { needsSetup: false, signupOpen: true, users: 1 }],
  ])("rejects %s", (_label, value) => {
    expect(setupStatusResponseSchema.safeParse(value).success).toBe(false);
  });
});
