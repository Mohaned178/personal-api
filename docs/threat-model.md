# Threat model (v1)

A short model of what Personal API protects, from whom, and how. Written in the M7-04 security
pass. The invariants in `CLAUDE.md` and PLAN §8 are the rules; this page says which threat each
one answers, and what v1 knowingly leaves open.

## What is worth protecting

| Asset | Where it lives |
| --- | --- |
| Browsing history: domain, path, visit and focus timings | `events` (Postgres), export files in `EXPORT_DIR`, database backups |
| What the user chose not to collect | Nowhere: dropped events are only counted in `ingestion_log` (invariant 2) |
| Dashboard login | Better Auth: password hash in `account`, session cookie (HttpOnly, SameSite=Lax, Secure on https) |
| Ingest keys (`pa_ing_`), read keys (`pa_read_`), pairing codes | Only SHA-256 hashes are stored. Keys have 256 random bits, codes 100 bits and expire after 10 minutes |
| Rules and saved queries | `rules`, `endpoints` (they say what the user cares about, so they are personal data too) |

## Who we defend against

| Actor | Can | Must not be able to |
| --- | --- | --- |
| A website the user visits | Run script in the user's browser | Read anything from the extension, or make the dashboard act (CSRF) |
| Another account on the same server | Use the API normally with its own session and keys | See, change or even confirm the existence of another user's data |
| Someone holding a shared endpoint key | Call `GET /v1/me/<slug>` | Read anything else, reach raw events through an aggregate-only endpoint, or exhaust the server |
| Someone holding a stolen ingest key | Send events as that integration | Read anything back, or reach another user's account |
| Someone on the network | Watch and change traffic | Read keys or cookies (https everywhere except loopback) |
| The person who reaches a fresh install first | Open the sign-up page | Become the owner of someone else's server (see "Operator checklist") |

Out of scope: anyone with shell, Docker or database access on the host (they can read
everything), and a compromised browser or OS on the user's machine.

## Threats and what stops them

### Browser → extension

- **Collecting too much.** Deny by default: a new extension collects nothing until a rule allows
  a site. Missing, invalid or failing rules mean no capture (invariant 1). The URL sanitizer keeps
  only domain and path (query and fragment are always stripped in v1). Incognito tabs, titles,
  form contents and keystrokes are never read. There are no content scripts and no
  `<all_urls>`: the permissions are `tabs`, `idle`, `storage`, `alarms` and one runtime-granted
  server origin.
- **Leaking the key to the wrong place.** The server URL must be https (plain http only for
  loopback). Every request uses `credentials: "omit"` and `redirect: "error"`, so a redirect
  can't carry the key elsewhere. Pairing with a different server or integration discards the old
  queue, so queued events never reach the new owner.

### Extension → API (ingest)

- **Forged or malformed events.** Strict per-type Zod schemas reject unknown keys, including
  `userId`, `integrationId` and `receivedAt`. The user and integration come from the key, never
  from the body (invariant 4).
- **Ignoring the rules.** The server applies the collect rules again, because the extension is
  untrusted and rules can change while events wait in its queue. A drop always drops. See the
  accepted risk on the collected-trust shortcut below.
- **Replays and retries.** `UNIQUE (user_id, integration_id, client_event_id)` turns them into
  `duplicate` results.
- **Flooding.** 256 KB and 100 events per batch, and 120 requests a minute per ingest key.

### Dashboard (session cookie)

- **CSRF.** `CsrfGuard` refuses every cookie-carrying POST, PATCH, PUT or DELETE whose `Origin`
  (or, without one, `Sec-Fetch-Site`) is not the dashboard's own. Better Auth checks the origin on
  its own routes. GET routes change nothing.
- **Password guessing.** Sign-in and sign-up are limited to 3 per 10 seconds per client address
  (Better Auth), outside the test suites. Deleting the account asks for the password again
  (5 tries in 15 minutes).
- **XSS.** React escapes all output, the dashboard uses no `dangerouslySetInnerHTML`, and helmet
  sends a CSP of `script-src 'self'`, `object-src 'none'` and `frame-ancestors 'self'`, plus
  `nosniff` and `no-referrer`.
- **Secrets lingering.** A new key or pairing code is shown once and kept in component state only,
  never in the query cache or browser storage.

### Read API and saved queries

- **Scope escalation.** A read key reads only within its scopes and its source and type
  restriction. An endpoint key (`endpoint:<id>`) runs only that endpoint. A disabled endpoint, an
  unknown slug and a key without the scope all return the same 404.
- **Injection.** Saved queries and filters are built with Drizzle's query builder. Field names
  come from a closed list and every value is a bound parameter (invariant 7). There is no regex
  and no code execution (invariant 8).
- **Exhausting the database.** Each run is read-only, with a 2-second `statement_timeout` and at
  most 1,000 rows. Since M7-04 every read key also has its own budget of 120 requests a minute
  (`429 read.rate_limited`), so one shared key can keep at most about 4 of the pool's
  10 connections busy.

### Across tenants

Every query on user data goes through the tenant-scope helpers with the `userId` from the
`AuthContext`. Routes answer 404, never 403, for another user's resources. Two suites check this:
the cross-tenant sweep, and the route-table suite (M7-02), which reads the guards Nest actually
registered and fails when a route without auth is not on the explicit allowlist.

### Logs, errors and stored files

- pino serializers drop URLs, headers and bodies, and a redaction list censors sensitive keys at
  any depth (invariant 6). Unexpected errors are logged by name only, and the 500 body says
  nothing.
- Export files sit in owner-only directories named by UUID. A download is session-only and
  `no-store`, and the link expires after 24 hours. Account deletion removes the files before the
  rows.

## Accepted risks in v1

1. **Collected-trust shortcut** (`docs/rule-format.md`, open item 1). An event from a
   browser-extension key that names the current rule-set version skips the default policy when an
   `allow` rule reads a field a collect transform rewrites. Someone with that ingest key can then
   store events that no rule allows, as long as no rule drops them. The damage is limited to
   writing into the key owner's own account (nothing can be read back). Revoking the integration
   stops it.
2. **Rate limits live in memory, per process.** A restart resets them, and running several API
   processes multiplies them. v1 runs one API process.
3. **Behind a reverse proxy, `TRUST_PROXY` must equal the real number of hops.** Set it too low
   and every client shares one budget (safe, but legitimate users get throttled together). Set it
   too high and a client can choose its own address and get a fresh budget each time.
4. **Backups keep deleted data** until they rotate (`docs/data-lifecycle.md`).
5. **The extension trusts the server it's paired with.** That server decides the rules, so a
   compromised server could widen collection, but only within what the extension can see (domain
   and path of normal tabs).
6. **No Postgres row-level security.** Tenant isolation is enforced in the application code, and
   the tests above guard it. RLS is planned for v1.1.
7. **Public metadata.** `/healthz`, `/readyz` (whether the database and queue are up), `/docs`
   (request shapes only) and `/v1/setup/status` (whether an account exists and signups are open)
   need no login.
8. **Sessions store the client IP and user agent** (a Better Auth default). These are deleted
   with the account.

## Operator checklist

- Create the owner account before exposing a fresh install (`docs/self-hosting.md`). Until an
  account exists, anyone who reaches the sign-up page becomes the owner, even with
  `ALLOW_SIGNUP=false`.
- Serve it over https and set `NODE_ENV=production` (then `BETTER_AUTH_URL` must be https).
- Set `TRUST_PROXY` to the number of reverse proxies in front, and no higher.
- Keep `ALLOW_SIGNUP=false` unless you mean to host other people.
- Protect backups and `EXPORT_DIR` like the database itself.

## M7-04 review log

Reviewed: auth and CSRF, API keys and pairing, ingest and server-side rule enforcement, saved
queries, exports, static serving, logging and config, the extension's connect, queue and sanitizer
code, and the dashboard's storage of secrets. Findings:

| # | Severity | Finding | Outcome |
| --- | --- | --- | --- |
| 1 | Should-fix | Read-key routes had no rate limit. A shared endpoint key could hold pool connections (2 s each) and starve ingest and the dashboard. | Fixed: 120 requests a minute per read key, `429 read.rate_limited` with `Retry-After` |
| 2 | Should-fix | The login and sign-up limit only applied with `NODE_ENV=production`, but NODE_ENV defaults to `development`. | Fixed: on everywhere except `NODE_ENV=test` |
| 3 | Docs | Takeover of a fresh install by whoever signs up first | Already in `docs/self-hosting.md`; added to the checklist above |
| 4 | Nit | A stale "TODO M7-03" about `TRUST_PROXY` in the pairing limiter | Fixed |

Not covered here: the dependency audit and license check (M7-05).
