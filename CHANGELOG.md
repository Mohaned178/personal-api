# Changelog

All notable changes to Personal API are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [1.2.0] - Unreleased

"Take back your time": limits, pauses and focus that you set yourself, and a clearer picture of where the time goes.

### Added

- **Daily site limits** with notifications. A limit is a site pattern and minutes per day, with an optional strict
  mode. The popup shows the time left, the badge turns red at the limit, and the tab moves to a "Time's up" page
  ("5 more minutes" unless strict). Limits reset at local midnight.
- **Focus mode and schedules.** Block sites for a set number of minutes, or on chosen weekdays and times. Blocks
  are enforced on the device and never change what is collected.
- **Pause before opening.** Pick sites that show a 5 to 10 second pause before they open. The address being opened is
  never stored or sent.
- **Recommendations** on Insights and each site's page, from your own last two to four weeks: a stepped limit plan,
  a lower limit you stayed under, or a late-night schedule. Each one can be applied or dismissed. No outside service.
- **Detailed dashboard.** A per-site page (time per day, visits, sessions, top paths), an hour-by-weekday heatmap,
  this week against last week per site, and a timeline of today's sessions, in your time zone.
- **Categories, goals and a weekly summary.** Sites are productive, neutral or distracting (an editable list kept in
  the dashboard). Insights shows the split, goals such as "under 1h of distracting sites per day" with a streak, and
  a weekly summary of this week against last.

### Changed

- The extension asks for the `notifications` permission, for limit notifications. It is the only new permission.

## [1.1.0] - Unreleased

"Easy to use": a non-developer connects, picks what to track and sees time per site without writing rules.

### Added

- **One-click connect.** The popup needs only the server URL; the dashboard's **Connect this browser**
  button pairs the extension and the tab closes. Manual pairing codes still work. See
  [`docs/adr/0003-one-click-connect.md`](docs/adr/0003-one-click-connect.md).
- **Setup wizard** with rule presets: everything except sensitive sites, only work sites, or chosen sites.
- **Insights home** with today's and this week's time, a 7-day chart and top sites, and grouped navigation.
- **Popup "Today".** The top 5 sites with time, computed on the device, and a **Stop tracking this site**
  link that prefills a drop rule.

### Changed

- The extension never captures the connected server's own origin, even under an allow-all rule.
- `GET /v1/events` and `GET /v1/activity/*` take the dashboard session only. The home tagline is
  now "Your Data. Your Rules."

### Removed

- **Saved-query endpoints and read keys.** `/v1/endpoints`, `GET /v1/me/:slug`, `/v1/keys`, the Read keys
  and Endpoints pages, `pa_read_` keys and their rate limit are gone, with `docs/saved-queries.md`. The
  routes answer 404, and a `pa_read_` key is an unknown bearer (401). Migration `0013` deletes the
  endpoints and read keys that existed and drops the `endpoints` table and the read-key columns of
  `api_keys`. Ingest keys (`pa_ing_`) and pairing are unchanged. The demo e2e is now six steps.

## [1.0.0] - Unreleased

First v1 release. The tag `v1.0.0` is not created yet; it needs the owner's approval.

### Added

- **Ingestion API.** Batched event ingest (`POST /v1/ingest/events`) with effectively-once storage, a
  heartbeat (`POST /v1/ingest/heartbeat`) and a rule-set config endpoint with ETag
  (`GET /v1/ingest/config`). Events are validated against versioned event-type schemas.
- **API keys.** Ingest keys (`pa_ing_`) can only ingest and read keys (`pa_read_`) can only read within
  their scopes. Keys are stored as SHA-256 hashes and shown once.
- **Browser extension** (Firefox first, with an Edge build). It pairs with a server, captures page visits,
  tab open and close, and focus segments, and keeps domain and path only. Events wait in an offline queue
  with retry, and the popup shows connection state, pause and resume, queue depth and the current tab's
  verdict. Nothing is collected for a site until the user allows it.
- **Rules.** A JSON rule format with `collect` and `process` stages, validated on save. Rules API with
  versioning and history, `POST /v1/rules/test`, and server enforcement with stored traces. The dashboard
  has a rule builder with a JSON view and starter templates, and each event shows why it was kept.
- **Dashboard.** First-run setup, sign-up, login and logout. Pages for integrations (extension pairing and
  HTTP integrations), events (filters, detail drawer, multi-select delete), rules, keys, endpoints and
  health.
- **Query API.** Read keys with scopes, `GET /v1/events`, `GET /v1/activity/daily` and
  `GET /v1/activity/domains`, saved-query endpoints at `GET /v1/me/:slug` with CRUD and a live `curl`
  preview, and OpenAPI docs at `/docs`.
- **Data lifecycle.** Retention policies with a scheduled purge, bulk delete by filter as a job, account
  deletion that removes every table, key, session and export file, and export as NDJSON.gz with a
  `manifest.json`.
- **Packaging.** Multi-stage Dockerfile, a production compose file with a one-shot migration service, a
  Caddy example, extension store zips, and a license check in CI. Licensed under AGPL-3.0-only
  (see `LICENSE`).

### Security

- Rate limits on login, pairing, ingest (per key) and reads (per read key).
- Helmet security headers, and CSRF checks on every session-cookie mutation.
- Route-table-generated tests check every route for unauthenticated, wrong-key-type and cross-tenant access.
- Log redaction for payloads, URLs, keys, cookies and emails. Dropped events are kept as counters only.
- Threat model in [`docs/threat-model.md`](docs/threat-model.md).

### Known limitations

- The `keep_query` rule action is reserved for v1.1: the rules API rejects it on save, and query strings
  are always stripped. See open item 2 in [`docs/rule-format.md`](docs/rule-format.md).
- Exporting data and deleting the account are available through the API only (`POST /v1/exports`,
  `DELETE /v1/account`). The dashboard screens for them come in v1.1.
- A rule that reads a field it also rewrites can fail to match its own output when the event is evaluated
  again. See open item 1 in [`docs/rule-format.md`](docs/rule-format.md).
- The Edge build has a smoke test only.
- Element interactions and the webhook `forward` action are planned for v1.1.
- The Chrome Web Store listing comes after v1.
