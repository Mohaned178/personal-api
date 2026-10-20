/** The `RateLimiter` behind the ingest routes, one counter per key. Tests fetch it to reset it. */
export const INGEST_RATE_LIMITER = Symbol("INGEST_RATE_LIMITER");
