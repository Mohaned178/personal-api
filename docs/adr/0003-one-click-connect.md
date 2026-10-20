# ADR 0003: One-click connect

- **Status:** Accepted (M8-01, 2026-10-21).
- **Code:** `apps/extension/lib/one-click.ts`, `apps/extension/lib/queue/wire.ts` (listeners and
  the server-origin skip), `apps/extension/lib/capture/engine.ts` (`pageOf`), `apps/web/src/routes/connect-extension-page.tsx`,
  `apps/web/src/lib/safe-redirect.ts`.
- **Tests:** `apps/extension/test/one-click.spec.ts`, `apps/extension/test/queue/wire.spec.ts`,
  `apps/extension/test/rules/wiring.spec.ts`, `apps/web/src/routes/connect-extension.spec.tsx`,
  `apps/web/src/lib/safe-redirect.spec.ts`, `apps/e2e/tests/extension-one-click-firefox.spec.ts`.

## Context

Pairing (PLAN §7, M2-01/M2-02) asks the user to create an integration in the dashboard, copy a
10-minute pairing code, and type it with the server URL into the popup. That is too much for a
non-developer (M8). We want the popup to need only the server URL, without new permissions,
without a content script and without weakening the pairing model: the code stays single use,
short lived and hashed on the server, and `POST /v1/pair` is unchanged.

## Decision

1. **Popup (inside the click).** With the server URL and no code, the popup page (opened in a tab,
   as before, so the permission prompt cannot close it) requests the origin permission
   synchronously, opens `<server>/connect-extension` in a new tab, and writes
   `{ tabId, origin, expiresAt }` to `browser.storage.session` (30 minutes, enough to sign in).
   No code exists yet, and none is ever written there. A code typed into the field keeps the
   manual flow.
2. **Dashboard.** `/connect-extension` requires a session. A signed-out user is sent to login (or
   first-run setup) with `?redirect=/connect-extension`, and comes back after signing in. The page
   creates nothing on load: the user presses **Connect this browser**, which creates a
   `browser-extension` integration (named after the browser family) and a pairing code, then
   replaces the URL with `/connect-extension/done#code=<code>`. The code is never put in React
   Query's cache.
3. **Background.** A top-level `tabs.onUpdated` listener ignores every URL that does not contain
   `/connect-extension/done` without reading storage. For one that does, it reads the pending
   connect and takes the code only if the tab id matches, the URL's origin equals the stored
   origin exactly (scheme, host and port), the path is exactly `/connect-extension/done`, there is
   no query and no userinfo, and the code has the expected shape. It removes the pending entry
   **before** redeeming (calls are serialized, so a tab that reports the URL twice is redeemed
   once), then pairs through `pairWithCode`, the second half of the manual `connect()`: queue owner
   adoption, stored connection, rules sync. On success it closes the tab. On failure it keeps the
   tab open, because the done page shows the code to type in, and stores only a fixed message for
   the popup. `tabs.onRemoved` forgets a pending connect whose tab was closed.
4. **Capture never records the server.** The capture engine treats a tab URL on the connected
   server's exact origin (scheme, host and port) like an unsupported scheme, whatever the rules
   say, so an "allow all" preset (M8-02) never records the dashboard or the connect pages. The
   check runs where the engine sanitizes the raw tab URL, because the sanitized page keeps only
   domain and path, and other apps on the same host (another port) are still captured.
5. **Redirects are internal only.** `safeRedirect` keeps a `redirect` only when it is a path on the
   dashboard. It refuses `//host`, backslashes, control characters, absolute URLs, the auth pages
   themselves, and over-long values, and it drops the fragment. The auth routes always set
   `redirect` in their validated search (to `undefined` when refused), because TanStack Router
   merges the root route's raw search into a child's validated one. Leaving the key out let the
   unchecked value through, which a test caught.

## Why this is safe

- **Who can read the code.** It exists only in the dashboard tab's URL fragment, which the browser
  never sends to the server. Other web pages cannot read another tab's URL. The extension's
  background reads it, but only for the tab it opened and only on the origin the user typed and
  granted. A page on another origin, or another tab on the same origin, is ignored.
- **No new permission, no content script.** Reading tab URLs uses the `tabs` permission the
  extension already has. Opening a tab needs none.
- **No silent creation.** A link from another site to `/connect-extension` only shows a button.
  Creating the integration is a session-authenticated, CSRF-checked POST made after a click.
- **Nothing persisted.** The code is in memory for one request. `storage.session` holds only the
  tab id, origin and expiry, and it is cleared at the first matching URL, on tab close, on expiry
  and by a browser restart. The page-visit event for the done page (when it is captured at all) is
  domain + path only, so the fragment is stripped like any other (invariant 3).

## Consequences

- **Browser history keeps the done URL, code included.** The code is single use and spent within
  seconds. If pairing fails it expires after 10 minutes on the server. We accept this rather than
  stripping the fragment from the page, which would race the background reading it.
- If the background is killed between the URL change and the redeem, the listener is registered at
  the top level, so the browser restarts it with the event. If the event is lost anyway, the
  done page shows the code for manual entry.
- A first version skipped the server's whole hostname. The Firefox e2e caught that this also
  dropped every other app on `127.0.0.1`, so the skip is now the exact origin. The check reads the
  stored connection once per sanitized URL, outside the gate's single read (ADR 0002 decision 3).
- `localhost`/`127.0.0.1` servers keep working over plain http, as before (`normalizeServerUrl`).
