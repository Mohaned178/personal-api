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
    const { pool } = fakePool({ usersExist: true });
    const gate = new SignupGate(closed, pool);
    const signup = vi.fn(async () => {});

    await expect(gate.admit(signup)).resolves.toBe(false);
    expect(signup).not.toHaveBeenCalled();
    await expect(gate.isOpen()).resolves.toBe(false);
  });

  it("with ALLOW_SIGNUP=false refuses via a cheap pool check, without connecting, locking or queuing", async () => {
    const { pool, raw, client, calls } = fakePool({ usersExist: true });
    const gate = new SignupGate(closed, pool);
    const signup = vi.fn(async () => {});

    await expect(gate.admit(signup)).resolves.toBe(false);
    expect(signup).not.toHaveBeenCalled();
    expect(raw.query).toHaveBeenCalled(); // the cheap check ran on the pool...
    expect(raw.connect).not.toHaveBeenCalled(); // ...so no connection was held,
    expect(client.query).not.toHaveBeenCalled(); // ...no advisory lock was taken,
    expect(calls).toEqual([]);
  });

  it("refuses signups while a first signup holds the queue, without waiting behind it", async () => {
    // The first account is being created (slow) and, once done, an account exists. A signup
    // that arrives meanwhile must not wait for the lock/queue if the cheap check already says no.
    const state = { usersExist: false };
    const { pool, raw } = fakePool({ usersExist: false });
    raw.query.mockImplementation(async () => ({ rows: [{ exists: state.usersExist }] }));
    const gate = new SignupGate(closed, pool);

    let release: () => void = () => {};
    const gateOpen = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = gate.admit(async () => {
      state.usersExist = true;
      await gateOpen; // slow signup still in flight
    });
    await new Promise((resolve) => setImmediate(resolve));

    const lateSignup = vi.fn(async () => {});
    const late = await Promise.race([
      gate.admit(lateSignup),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 100)),
    ]);
    release();
    await first;

    expect(late, "a refused signup must not queue behind the in-flight one").toBe(false);
    expect(lateSignup).not.toHaveBeenCalled();
  });

  it("with no accounts the cheap check lets the signup through to the locked path", async () => {
    const { pool, calls } = fakePool({ usersExist: false });
    const gate = new SignupGate(closed, pool);
    await expect(gate.admit(async () => {})).resolves.toBe(true);
    expect(calls).toEqual(["lock", "check", "unlock", "release"]);
  });

  it("fails closed when the cheap check errors: the signup is refused or rejected, never run", async () => {
    const { pool, raw } = fakePool({ usersExist: false });
    raw.query.mockImplementation(async () => {
      throw new Error("db down");
    });
    const gate = new SignupGate(closed, pool);
    const signup = vi.fn(async () => {});

    const outcome = await gate.admit(signup).then(
      (admitted) => admitted,
      () => "threw",
    );
    expect(outcome === false || outcome === "threw").toBe(true);
    expect(signup).not.toHaveBeenCalled();
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
