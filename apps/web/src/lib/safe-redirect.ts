/**
 * Where to go after login, signup or first-run setup (M8-01): the `redirect` search parameter,
 * kept only when it is a path on this dashboard. Anything else is `undefined` (go home), so a link
 * to `/login?redirect=…` can never send the user to another site. The fragment is dropped (it may
 * carry a pairing code), and the auth pages themselves are refused so a redirect cannot loop.
 */
const MAX_LENGTH = 1024;
const BASE = "http://dashboard.invalid";
const AUTH_PATHS = new Set(["/login", "/signup", "/setup"]);

export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH) return;
  // `//host` and `/\host` are other origins to a browser; control characters are stripped by the
  // URL parser and can turn `/\t/host` into `//host`. Refuse them before parsing.
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\p{Cc}]/u.test(value)) return;
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return;
  }
  if (url.origin !== BASE || AUTH_PATHS.has(url.pathname)) return;
  return `${url.pathname}${url.search}`;
}
