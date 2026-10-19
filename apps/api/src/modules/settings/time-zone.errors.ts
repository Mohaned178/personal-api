import { TIME_ZONE_UNSUPPORTED_CODE } from "@personal-api/contracts";
import { hasPgErrorCode, PG_INVALID_PARAMETER_VALUE } from "../../platform/db/pg-error";
import { AppException } from "../../platform/errors/problem";

/** 400: the zone in a settings change is not one the database knows. */
export function unsupportedTimeZoneRequest(): AppException {
  return new AppException(
    400,
    TIME_ZONE_UNSUPPORTED_CODE,
    "Unsupported time zone",
    "The server does not know this time zone. Pick one from GET /v1/settings/time-zones.",
  );
}

/**
 * Runs a query that cuts days in the user's saved zone. A zone that was saved before the check
 * existed (or that a database upgrade dropped) makes Postgres raise `invalid_parameter_value`;
 * that is the user's setting to fix, a 409, and not a 500.
 */
export async function withSavedTimeZone<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (hasPgErrorCode(error, PG_INVALID_PARAMETER_VALUE)) {
      throw new AppException(
        409,
        TIME_ZONE_UNSUPPORTED_CODE,
        "Saved time zone is unsupported",
        "The database does not know the time zone in your settings. Choose another one.",
      );
    }
    throw error;
  }
}
