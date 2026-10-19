import { describe, expect, it } from "vitest";
import { hasPgErrorCode, PG_INVALID_PARAMETER_VALUE } from "./pg-error";

describe("hasPgErrorCode", () => {
  it("finds the code on the error, or on a cause up to three levels deep", () => {
    expect(hasPgErrorCode({ code: "22023" }, PG_INVALID_PARAMETER_VALUE)).toBe(true);
    expect(hasPgErrorCode({ cause: { code: "22023" } }, PG_INVALID_PARAMETER_VALUE)).toBe(true);
    expect(
      hasPgErrorCode({ cause: { cause: { code: "22023" } } }, PG_INVALID_PARAMETER_VALUE),
    ).toBe(true);
    expect(
      hasPgErrorCode(
        { cause: { cause: { cause: { code: "22023" } } } },
        PG_INVALID_PARAMETER_VALUE,
      ),
    ).toBe(false);
  });

  it("is false for another code, a non-object and nothing", () => {
    expect(hasPgErrorCode({ code: "23505" }, PG_INVALID_PARAMETER_VALUE)).toBe(false);
    for (const value of [undefined, null, "22023", 22023]) {
      expect(hasPgErrorCode(value, PG_INVALID_PARAMETER_VALUE)).toBe(false);
    }
  });
});
