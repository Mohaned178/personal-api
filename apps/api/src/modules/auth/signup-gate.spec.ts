import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { SIGNUP_LOCK_ID, SignupGate } from "./signup-gate";

/** A fake pool whose single client answers the lock, unlock and "any user?" queries. */
function fakePool(options: { usersExist: boolean; failUnlock?: boolean }) {
  const calls: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("pg_advisory_lock")) {
        expect(params).toEqual([SIGNUP_LOCK_ID]);
        calls.push("lock");
        return { rows: [] };
      }
      if (sql.includes("pg_advisory_unlock")) {
        calls.push("unlock");
        if (options.failUnlock) throw new Error("connection lost");
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      calls.push("check");
      return { rows: [{ exists: options.usersExist }] };
    }),
    release: vi.fn((destroy?: boolean) => {
      calls.push(destroy ? "destroy" : "release");
    }),
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async () => ({ rows: [{ exists: options.usersExist }] })),
  };
  return { pool: pool as unknown as Pool, raw: pool, client, calls };
}

const closed = { ALLOW_SIGNUP: false };
const open = { ALLOW_SIGNUP: true };

describe("SignupGate", () => {
  it("with ALLOW_SIGNUP=true runs every signup without touching the database", async () => {
    const { pool, raw } = fakePool({ usersExist: true });
    const gate = new SignupGate(open, pool);
    const signup = vi.fn(async () => {});

    await expect(gate.admit(signup)).resolves.toBe(true);
    await expect(gate.isOpen()).resolves.toBe(true);
    expect(signup).toHaveBeenCalledOnce();
    expect(raw.connect).not.toHaveBeenCalled();
    expect(raw.query).not.toHaveBeenCalled();
  });

  it("with ALLOW_SIGNUP=false admits the first account under the lock, then unlocks", async () => {
    const { pool, calls } = fakePool({ usersExist: false });
    const gate = new SignupGate(closed, pool);
    const signup = vi.fn(async () => {
      calls.push("signup");
    });

    await expect(gate.admit(signup)).resolves.toBe(true);
    expect(calls).toEqual(["lock", "check", "signup", "unlock", "release"]);
  });

  it("with ALLOW_SIGNUP=false refuses once an account exists, without running the signup", async () => {
    const { pool, calls } = fakePool({ usersExist: true });
    const gate = new SignupGate(closed, pool);
    const signup = vi.fn(async () => {});

    await expect(gate.admit(signup)).resolves.toBe(false);
    expect(signup).not.toHaveBeenCalled();
    expect(calls).toEqual(["lock", "check", "unlock", "release"]);
    await expect(gate.isOpen()).resolves.toBe(false);
  });

  it("fails closed when the user check returns something unexpected", async () => {
    const { pool, client } = fakePool({ usersExist: false });
    client.query.mockImplementation(async () => ({ rows: [] }));
    const gate = new SignupGate(closed, pool);
    const signup = vi.fn(async () => {});

    await expect(gate.admit(signup)).resolves.toBe(false);
    expect(signup).not.toHaveBeenCalled();
  });

  it("still unlocks and releases the client when the signup throws", async () => {
    const { pool, calls } = fakePool({ usersExist: false });
    const gate = new SignupGate(closed, pool);

    await expect(
      gate.admit(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(calls).toEqual(["lock", "check", "unlock", "release"]);
  });

  it("destroys the connection (dropping the lock) when unlocking fails", async () => {
    const { pool, calls } = fakePool({ usersExist: false, failUnlock: true });
    const gate = new SignupGate(closed, pool);

    await expect(gate.admit(async () => {})).resolves.toBe(true);
    expect(calls.at(-1)).toBe("destroy");
  });

  it("queues signups in-process so they never overlap", async () => {
    const { pool } = fakePool({ usersExist: false });
    const gate = new SignupGate(closed, pool);
    let running = 0;
    let maxRunning = 0;
    const signup = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setImmediate(resolve));
      running--;
    };

    await Promise.all([gate.admit(signup), gate.admit(signup), gate.admit(signup)]);
    expect(maxRunning).toBe(1);
  });

  it("keeps serving the queue after a failed signup", async () => {
    const { pool } = fakePool({ usersExist: false });
    const gate = new SignupGate(closed, pool);

    const failed = gate.admit(async () => {
      throw new Error("boom");
    });
    const next = gate.admit(async () => {});
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe(true);
  });
});
