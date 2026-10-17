import { describe, expect, it, vi } from "vitest";
import { SetupController } from "./setup.controller";
import type { SignupGate } from "./signup-gate";

function controller(gate: Partial<Record<"needsSetup" | "isOpen", () => Promise<boolean>>>) {
  return new SetupController(gate as unknown as SignupGate);
}

describe("SetupController", () => {
  it("reports first-run with signup open when no user exists", async () => {
    const c = controller({ needsSetup: async () => true, isOpen: async () => true });
    await expect(c.status()).resolves.toEqual({ needsSetup: true, signupOpen: true });
  });

  it("reports closed signup once an account exists and ALLOW_SIGNUP is false", async () => {
    const c = controller({ needsSetup: async () => false, isOpen: async () => false });
    await expect(c.status()).resolves.toEqual({ needsSetup: false, signupOpen: false });
  });

  it("returns only the two booleans", async () => {
    const c = controller({ needsSetup: async () => false, isOpen: async () => true });
    expect(Object.keys(await c.status()).sort()).toEqual(["needsSetup", "signupOpen"]);
  });

  it("fails closed: a database error propagates instead of answering", async () => {
    const c = controller({
      needsSetup: vi.fn().mockRejectedValue(new Error("db down")),
      isOpen: async () => true,
    });
    await expect(c.status()).rejects.toThrow("db down");
  });
});
