import { z } from "zod";
import { safeMessage } from "./errors.js";

/**
 * Field schemas shared by several event types. They enforce privacy invariant 3 at the contract
 * level: browser events carry a domain and a path only, never a query string, a fragment or a
 * full URL.
 */

/** Longest path accepted in an event (characters). Longer paths are rejected, not truncated. */
export const MAX_PATH_LENGTH = 2048;

/** RFC 1035 limit for a hostname. */
export const MAX_DOMAIN_LENGTH = 253;

/**
 * Any RFC 9562 UUID: versions 1 to 8 with the RFC variant (10xx). Nil and Max are rejected
 * because they cannot identify an event. Case-insensitive on input, lowercased on output so the
 * dedupe key `(user_id, integration_id, client_event_id)` does not depend on the client's casing.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const eventIdSchema = z
  .string()
  .max(36)
  .regex(UUID_PATTERN, safeMessage("Expected an RFC 9562 UUID"))
  .transform((id) => id.toLowerCase());

/** An ISO 8601 date-time in UTC with a `Z` suffix (no offsets, no local times, real dates only). */
export const utcDateTimeSchema = z.iso
  .datetime()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: safeMessage("Expected a valid date-time"),
  });

/**
 * A lowercase ASCII hostname (IDNs in punycode form): labels of 1 to 63 characters from
 * [a-z0-9-] that do not start or end with a hyphen, separated by single dots, 253 characters at
 * most. No scheme, port, userinfo, path, wildcard or trailing dot.
 */
const DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export const domainSchema = z
  .string()
  .min(1)
  .max(MAX_DOMAIN_LENGTH)
  .regex(DOMAIN_PATTERN, safeMessage("Expected a lowercase ASCII hostname"));

/**
 * A URL path that starts with `/`. It never contains `?` or `#` (the query string and fragment
 * are stripped before an event is built), control characters, or lone UTF-16 surrogates. With the
 * `u` flag a surrogate pair is one astral code point (accepted) while an unpaired surrogate is
 * `\p{Cs}` (rejected), so the path is well-formed Unicode: Postgres `jsonb` refuses an unpaired
 * `\uD800`-`\uDFFF` escape, and one such item would otherwise fail the whole batch's insert.
 */
const PATH_PATTERN = /^\/[^?#\p{Cc}\p{Cs}]*$/u;

export const pathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .regex(
    PATH_PATTERN,
    safeMessage("Expected a path starting with / without a query string or fragment"),
  );

/** A per-browser-session random tab reference. Never the Chrome tab id. */
export const tabRefSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]{8,64}$/,
    safeMessage("Expected a random tab reference of 8 to 64 URL-safe characters"),
  );
