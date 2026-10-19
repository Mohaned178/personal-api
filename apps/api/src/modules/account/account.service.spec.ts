import { ACCOUNT_DELETE_CONFIRMATION } from "@personal-api/contracts";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../test/fake-clock";
import { AppException } from "../../platform/errors/problem";
import { RateLimiter } from "../../platform/rate-limit/rate-limiter";
import type { Auth } from "../auth/auth";
import type { SessionAuthContext } from "../auth/auth-context";
import { ACCOUNT_DELETE_ATTEMPTS_PER_WINDOW, ACCOUNT_DELETE_WINDOW_MS } from "./account.constants";
import type { AccountRepository } from "./account.repository";
import { AccountRateLimitedError, AccountService } from "./account.service";
import { AccountDeletionSteps } from "./account.steps";

const auth: SessionAuthContext = {
  kind: "session",
  userId: "user-1",
  sessionId: "s1",
  user: { id: "user-1", email: "me@example.test", name: "Me" },
};
const request = { password: "right", confirm: ACCOUNT_DELETE_CONFIRMATION } as const;

function setup(options: { hash?: string | null } = {}) {
  const calls: string[] = [];
  const repository = {
    findPasswordHash: vi.fn(async () => (options.hash === undefined ? "hash" : options.hash)),
    deleteAccount: vi.fn(async () => {
      calls.push("delete");
    }),
  };
  const betterAuth = {
    $context: Promise.resolve({
      password: { verify: async ({ password }: { password: string }) => password === "right" },
      authCookies: {
        sessionToken: { name: "__Secure-x.session_token", attributes: { secure: true, path: "/" } },
        sessionData: { name: "__Secure-x.session_data", attributes: { secure: true, path: "/" } },
        dontRememberToken: { name: "__Secure-x.dont_remember", attributes: { secure: true } },
        accountData: { name: "__Secure-x.account_data", attributes: { secure: true, path: "/" } },
      },
    }),
  };
  const clock = new FakeClock();
  const limiter = new RateLimiter(
    { limit: ACCOUNT_DELETE_ATTEMPTS_PER_WINDOW, windowMs: ACCOUNT_DELETE_WINDOW_MS },
    clock,
  );
  const steps = new AccountDeletionSteps();
  const service = new AccountService(
    repository as unknown as AccountRepository,
    steps,
    betterAuth as unknown as Auth,
    limiter,
  );
  return { service, repository, steps, calls, clock };
}

describe("AccountService.delete", () => {
  it("runs the steps in order, then deletes the account of the session's user and email", async () => {
    const { service, repository, steps, calls } = setup();
    steps.register({ name: "one", run: async () => void calls.push("one") });
    steps.register({ name: "two", run: async () => void calls.push("two") });

    await service.delete(auth, request);

    expect(calls).toEqual(["one", "two", "delete"]);
    expect(repository.deleteAccount).toHaveBeenCalledWith("user-1", "me@example.test");
  });

  it("refuses a wrong password, and an account without one, with the same 403", async () => {
    for (const hash of ["hash", null]) {
      const { service, repository, steps } = setup({ hash });
      const step = vi.fn(async () => {});
      steps.register({ name: "never", run: step });
      const error = await service.delete(auth, { ...request, password: "wrong" }).catch((e) => e);
      expect(error).toBeInstanceOf(AppException);
      expect(error).toMatchObject({ code: "account.password_invalid" });
      expect(error.getStatus()).toBe(403);
      expect(step).not.toHaveBeenCalled();
      expect(repository.deleteAccount).not.toHaveBeenCalled();
    }
  });

  it("does not delete when a step throws", async () => {
    const { service, repository, steps } = setup();
    steps.register({
      name: "broken",
      run: async () => {
        throw new Error("boom");
      },
    });
    await expect(service.delete(auth, request)).rejects.toThrow("boom");
    expect(repository.deleteAccount).not.toHaveBeenCalled();
  });

  it("counts every attempt and throttles before looking at the password", async () => {
    const { service, repository, clock } = setup();
    for (let i = 0; i < ACCOUNT_DELETE_ATTEMPTS_PER_WINDOW; i++) {
      await expect(service.delete(auth, { ...request, password: "wrong" })).rejects.toMatchObject({
        code: "account.password_invalid",
      });
    }
    repository.findPasswordHash.mockClear();
    const error = await service.delete(auth, request).catch((e) => e);
    expect(error).toBeInstanceOf(AccountRateLimitedError);
    expect(error.getStatus()).toBe(429);
    expect(error.retryAfterSeconds).toBe(ACCOUNT_DELETE_WINDOW_MS / 1000);
    expect(repository.findPasswordHash).not.toHaveBeenCalled();

    clock.advance(ACCOUNT_DELETE_WINDOW_MS);
    await expect(service.delete(auth, request)).resolves.toBeUndefined();
  });
});

describe("AccountService.sessionCookies", () => {
  it("returns Better Auth's own cookie names (with a __Secure- prefix over https) to expire", async () => {
    const { service } = setup();
    const cookies = await service.sessionCookies();
    expect(cookies.map((c) => c.name)).toEqual([
      "__Secure-x.session_token",
      "__Secure-x.session_data",
      "__Secure-x.dont_remember",
      "__Secure-x.account_data",
    ]);
    for (const cookie of cookies) {
      expect(cookie.options).toEqual({ path: "/", httpOnly: true, secure: true, sameSite: "lax" });
    }
  });
});

describe("AccountDeletionSteps", () => {
  it("registers steps and unregisters them again", () => {
    const steps = new AccountDeletionSteps();
    const off = steps.register({ name: "a", run: async () => {} });
    expect(steps.list().map((s) => s.name)).toEqual(["a"]);
    off();
    off();
    expect(steps.list()).toEqual([]);
  });
});
