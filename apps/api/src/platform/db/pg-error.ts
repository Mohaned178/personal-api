/** Postgres `unique_violation`. */
export const PG_UNIQUE_VIOLATION = "23505";
/** Postgres `query_canceled`: what `statement_timeout` raises. */
export const PG_QUERY_CANCELED = "57014";
/** Postgres `invalid_parameter_value`: for example a time zone name the server does not know. */
export const PG_INVALID_PARAMETER_VALUE = "22023";

/** True when the error, or the driver error the ORM keeps as its `cause`, carries this SQLSTATE. */
export function hasPgErrorCode(error: unknown, code: string): boolean {
  for (
    let e = error as { code?: unknown; cause?: unknown } | undefined, depth = 0;
    e && depth < 3;
    depth++
  ) {
    if (e.code === code) return true;
    e = e.cause as typeof e;
  }
  return false;
}
