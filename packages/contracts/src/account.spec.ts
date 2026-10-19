import { describe, expect, it } from "vitest";
import {
  ACCOUNT_DELETE_CONFIRMATION,
  ACCOUNT_PASSWORD_MAX_LENGTH,
  deleteAccountRequestSchema,
} from "./account.js";

const valid = { password: "correct horse", confirm: ACCOUNT_DELETE_CONFIRMATION };

describe("deleteAccountRequestSchema", () => {
  it("accepts the password with the exact confirmation phrase", () => {
    expect(deleteAccountRequestSchema.parse(valid)).toEqual(valid);
  });

  it("refuses a missing, empty or too long password", () => {
    expect(deleteAccountRequestSchema.safeParse({ confirm: valid.confirm }).success).toBe(false);
    expect(deleteAccountRequestSchema.safeParse({ ...valid, password: "" }).success).toBe(false);
    const long = "x".repeat(ACCOUNT_PASSWORD_MAX_LENGTH + 1);
    expect(deleteAccountRequestSchema.safeParse({ ...valid, password: long }).success).toBe(false);
  });

  it("refuses any confirmation but the exact phrase", () => {
    for (const confirm of [
      undefined,
      "",
      "delete",
      "Delete my account",
      `${valid.confirm} `,
      true,
    ]) {
      expect(deleteAccountRequestSchema.safeParse({ ...valid, confirm }).success).toBe(false);
    }
  });

  it("is strict: the body cannot name a user or carry anything else", () => {
    for (const extra of [{ userId: "u1" }, { integrationId: "i1" }, { remember: true }]) {
      expect(deleteAccountRequestSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
  });
});
