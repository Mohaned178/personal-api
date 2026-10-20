import { EVENTS_CURSOR_INVALID_CODE, utcDateTimeSchema } from "@personal-api/contracts";
import { isUuid } from "../../platform/db/uuid";
import { AppException } from "../../platform/errors/problem";

export interface EventsCursor {
  occurredAt: Date;
  id: string;
}

/** Opaque to clients: base64url of `[occurredAt ISO, id]`. It carries nothing but the two keys. */
export function encodeCursor(position: EventsCursor): string {
  return Buffer.from(JSON.stringify([position.occurredAt.toISOString(), position.id])).toString(
    "base64url",
  );
}

function invalid(code: string): AppException {
  return new AppException(400, code, "Invalid cursor");
}

/**
 * Anything that is not exactly what `encodeCursor` makes is a 400, never a query. Other lists keyed
 * on `(timestamp, id)` reuse this with their own error `code`.
 */
export function decodeCursor(cursor: string, code = EVENTS_CURSOR_INVALID_CODE): EventsCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid(code);
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw invalid(code);
  const [iso, id] = parsed as unknown[];
  // The contract's date-time check also rejects expanded years (`+010000-...`), which round-trip
  // through `toISOString()` but which Postgres cannot read as a timestamptz.
  if (!utcDateTimeSchema.safeParse(iso).success || !isUuid(id)) throw invalid(code);
  const occurredAt = new Date(iso as string);
  if (Number.isNaN(occurredAt.getTime()) || occurredAt.toISOString() !== iso) throw invalid(code);
  return { occurredAt, id };
}
