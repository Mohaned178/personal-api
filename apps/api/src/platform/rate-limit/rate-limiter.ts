import type { Clock } from "../clock/clock";

export interface RateLimiterOptions {
  /** Attempts allowed per key in one window. */
  limit: number;
  windowMs: number;
  /** Most keys tracked at once. When full, expired windows go first, then the oldest key. */
  maxKeys?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Whole milliseconds until the key's window ends. Only meaningful when `allowed` is false. */
  retryAfterMs: number;
}

const DEFAULT_MAX_KEYS = 10_000;

/**
 * A fixed-window counter per key, in memory (v1 runs a single API process). Time comes from the
 * injected `Clock`, so tests move it instead of waiting. Every `consume` counts, whatever the
 * outcome of the request it guards, so a flood of wrong guesses and a flood of right ones are
 * throttled the same way.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  private readonly maxKeys: number;

  constructor(
    private readonly options: RateLimiterOptions,
    private readonly clock: Clock,
  ) {
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  consume(key: string): RateLimitResult {
    const now = this.clock.now().getTime();
    const current = this.windows.get(key);
    if (current && now - current.startedAt < this.options.windowMs) {
      if (current.count >= this.options.limit) {
        return { allowed: false, retryAfterMs: current.startedAt + this.options.windowMs - now };
      }
      current.count += 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    if (!current && this.windows.size >= this.maxKeys) this.makeRoom(now);
    // Re-inserted, so the map stays ordered by when each window started (oldest first).
    this.windows.delete(key);
    this.windows.set(key, { startedAt: now, count: 1 });
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Forgets every counter. For tests that share one client address. */
  reset(): void {
    this.windows.clear();
  }

  private makeRoom(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.options.windowMs) this.windows.delete(key);
    }
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) return;
      this.windows.delete(oldest.value);
    }
  }
}
