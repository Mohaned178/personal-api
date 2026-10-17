import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../../config/config";
import { APP_CONFIG } from "../../config/config.module";
import { PG_POOL } from "../../platform/db/db.tokens";

/**
 * Session-level advisory lock that serializes signups while ALLOW_SIGNUP=false, across every
 * API process sharing the database. The value is arbitrary but must stay stable.
 */
export const SIGNUP_LOCK_ID = 7_010_001;

const ANY_USER_SQL = 'SELECT EXISTS (SELECT 1 FROM "user") AS "exists"';

async function anyUserExists(db: Pick<Pool | PoolClient, "query">): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(ANY_USER_SQL);
  // Anything but a clear "no users" counts as "users exist", so a surprise fails closed.
  return rows[0]?.exists !== false;
}

/**
 * Decides whether a new account may be created: always when ALLOW_SIGNUP=true, otherwise only
 * while no account exists (the first account can always sign up).
 *
 * `admit` makes that check atomic with the signup itself. With signups closed it first refuses
 * cheaply if any account already exists. Otherwise it queues signups
 * in this process (so at most one pool connection waits on the lock), takes the advisory lock,
 * re-checks for users and only then runs the signup, holding the lock until the signup has
 * finished and committed. Concurrent first signups therefore admit exactly one.
 */
@Injectable()
export class SignupGate {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, "ALLOW_SIGNUP">,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  /** True while no account exists, so the dashboard should offer first-run setup. */
  async needsSetup(): Promise<boolean> {
    return !(await anyUserExists(this.pool));
  }

  /** A point-in-time answer, used as the backstop inside Better Auth's user-create hook. */
  async isOpen(): Promise<boolean> {
    if (this.config.ALLOW_SIGNUP === true) return true;
    return !(await anyUserExists(this.pool));
  }

  /** Runs `signup` if admitted and returns true; returns false without running it otherwise. */
  async admit(signup: () => Promise<void>): Promise<boolean> {
    if (this.config.ALLOW_SIGNUP === true) {
      await signup();
      return true;
    }
    // Cheap pre-check on the pool: once an account exists (the normal state), refuse without
    // holding a connection, taking the lock or queuing behind an in-flight signup. If it throws,
    // the error propagates and the signup never runs. A "no users" answer is not trusted on its
    // own: the locked path below re-checks.
    if (await anyUserExists(this.pool)) return false;
    return this.serialize(() => this.admitLocked(signup));
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async admitLocked(signup: () => Promise<void>): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [SIGNUP_LOCK_ID]);
    } catch (error) {
      client.release(true);
      throw error;
    }
    let unlocked = false;
    try {
      if (await anyUserExists(client)) return false;
      await signup();
      return true;
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [SIGNUP_LOCK_ID]);
        unlocked = true;
      } catch {
        // Destroying the connection below also drops the lock.
      }
      client.release(!unlocked);
    }
  }
}
