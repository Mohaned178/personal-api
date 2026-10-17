import { EVENTS_CURSOR_INVALID_CODE } from "@personal-api/contracts";
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

function invalid(): AppException {
  return new AppException(400, EVENTS_CURSOR_INVALID_CODE, "Invalid cursor");
}

/** Anything that is not exactly what `encodeCursor` makes is a 400, never a query. */
export function decodeCursor(cursor: string): EventsCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw invalid();
  const [iso, id] = parsed as unknown[];
  if (typeof iso !== "string" || !isUuid(id)) throw invalid();
  const occurredAt = new Date(iso);
  if (Number.isNaN(occurredAt.getTime()) || occurredAt.toISOString() !== iso) throw invalid();
  return { occurredAt, id };
}
