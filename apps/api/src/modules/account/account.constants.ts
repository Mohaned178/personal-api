/** The `RateLimiter` behind `DELETE /v1/account`. Tests fetch it to reset it. */
export const ACCOUNT_RATE_LIMITER = Symbol("ACCOUNT_RATE_LIMITER");

/**
 * Password checks per account per window. The route checks a password outside Better Auth's own
 * rate limit, so it gets its own: a person confirms a deletion once or twice, never 5 times in 15
 * minutes. Every attempt counts, right or wrong.
 */
export const ACCOUNT_DELETE_ATTEMPTS_PER_WINDOW = 5;
export const ACCOUNT_DELETE_WINDOW_MS = 15 * 60_000;
