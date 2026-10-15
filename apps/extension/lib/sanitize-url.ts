// M2-03 URL sanitizer (invariant 3). Pure: only the global WHATWG `URL`, which exists in the MV3
// background and in Node. It never throws and fails closed: anything it is not sure about is
// ignored (`null`), never partially kept.

import { domainSchema, pathSchema } from "@personal-api/contracts";

/** Input longer than this is ignored without being parsed. */
export const MAX_URL_INPUT_LENGTH = 8192;

export type SanitizedUrl = { domain: string; path: string };

/**
 * Reduce a page URL to the `domain` + `path` pair of a `browser.page_visited` event.
 *
 * - Only `http:` and `https:` are kept. Every other scheme (chrome://, edge://, about:, file://,
 *   moz-extension://, chrome-extension://, javascript:, data:, blob:, ftp:, view-source: ...) is `null`.
 * - The query string and fragment are dropped. Userinfo (credentials) and the port are never kept
 *   (the event has no field for either).
 * - The domain is what the URL parser gives: lowercase, IDN as punycode, one trailing dot removed.
 * - The path is the parser's normalised pathname, never percent-decoded, so an encoded `%3F` or
 *   `%23` stays as text and a real `?` or `#` can never appear. An empty path is `/`.
 * - The result must pass the contracts' `domainSchema` and `pathSchema`, so what is returned is
 *   exactly what the envelope accepts. Anything those reject (IPv6 literals, a host with an
 *   underscore, a path over the length cap) is `null`: dropped, not truncated.
 */
export function sanitizeUrl(input: unknown): SanitizedUrl | null {
  try {
    if (typeof input !== "string" || input.length === 0 || input.length > MAX_URL_INPUT_LENGTH) {
      return null;
    }
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    const hostname = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
    const domain = domainSchema.safeParse(hostname);
    const path = pathSchema.safeParse(url.pathname === "" ? "/" : url.pathname);
    if (!domain.success || !path.success) return null;
    return { domain: domain.data, path: path.data };
  } catch {
    return null;
  }
}
