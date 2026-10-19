# Personal API — v1 Plan

> **Your Data. Your Endpoints. Your Rules.**
> Status: approved direction, pre-code. Written 2026-10-13 from the brain dump plus the planning interview.

---

## 1. Decisions made in planning

| Question | Decision |
| --- | --- |
| Where it runs | **Self-hosted, multi-account.** One `docker compose up` on a PC or VPS. Every row is scoped to a user, so hosting for others stays possible later. |
| Rule authoring | **A JSON rule format edited through a dashboard form**, with a "view/edit JSON" toggle and a "test this rule" preview. |
| Endpoint customization | **Fixed endpoints plus user-defined saved queries** at `/v1/me/:slug`, each behind an API key scoped to that endpoint. |
| UI | **A web dashboard** for events, rules, keys, export/delete and health, plus a **small extension popup** for connecting, pausing and queue status. |
| Default URL capture | **Domain and path only.** The query string and `#fragment` are always stripped unless a rule opts a domain in. |
| Default collection policy | **Deny by default.** A fresh extension collects nothing until the user allows a site. This matches demo step 3 and "explicitly configure what may be collected". |
| Element interactions | **Deferred to v1.1.** v1 uses only the tabs and idle APIs, with no content scripts. |
| Browsers | **Firefox first, then Edge, then Chrome.** Two MV3 builds from one WXT codebase (`firefox-mv3` with an event-page background, `chrome-mv3` for Edge, and later Chrome). Firefox is the primary target: the full demo e2e runs on it, and Firefox-specific behaviour wins when the browsers differ. Edge is second: a smoke e2e in CI. v1 ships through Firefox Add-ons (AMO) first, then Edge Add-ons (both free). Chrome comes after v1 (v1.1): a Chrome smoke e2e and a Chrome Web Store listing. Until then Chrome, Brave and Opera can load the Edge build but are untested. Changed 2026-10-14 (Firefox + Edge) and 2026-10-18 (Firefox first, Chrome after v1). |
| Event storage model | **Fixed envelope columns plus a `data` JSONB payload validated against a versioned schema per event type.** This gives one common table and still keeps payloads strict. |
| Pace | Near full-time. Milestones are about 1 week each. |

---

## 2. Tech stack

The whole project uses TypeScript in strict mode. Coming from JavaScript, this is the biggest win: the extension, server, dashboard and rule engine share one set of types.

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | **Node 24 LTS**, **pnpm** workspaces + **Turborepo** | Standard monorepo. One install, cached builds. |
| Backend | **NestJS 11** on the default **Express 5** platform, with `nestjs-zod` + `@nestjs/swagger`, `@nestjs/throttler` and `nestjs-pino` | Modules and dependency injection keep about 8 domain areas organized. Guards cover the three auth types (session, ingest key, read key) and per-user scoping. The worker reuses the same services through a standalone app context. Express is used over the Fastify adapter because Better Auth, nestjs-zod and Swagger support it best, and raw speed isn't a constraint at this volume. |
| Database | **PostgreSQL 18** | JSONB for payloads with GIN indexes when needed. Unique constraints give real dedupe and transactions give safe ingest. Native `uuidv7()`. It also hosts the job queue, so there's no Redis. SQLite is too weak for multi-account use plus a queue plus a concurrent worker. |
| Data access | **Drizzle ORM** + drizzle-kit migrations | TS-first and close to SQL. Dynamic JSONB filters for saved queries are built with its query builder, never with string SQL. One tool instead of Prisma + Kysely. |
| Jobs | **pg-boss** | A Postgres-backed queue with retries, cron and a dead-letter queue. Used for retention purges, bulk deletes, exports and (later) webhook delivery. |
| Dashboard auth | **Better Auth** (Drizzle adapter), email + password sessions | Self-hostable. TOTP and passkeys are available later. |
| Machine auth | Custom **hashed API keys** (`pa_ing_…`, `pa_read_…`), SHA-256 at rest, shown once | Keys are simple, revocable and scoped. Ingest keys and read keys are separate. |
| Contracts | **Zod 4** in `packages/contracts` | One source of truth for the envelope, event types, rule format and API DTOs. |
| Extension | **WXT** (Vite-based, MV3) + TypeScript; IndexedDB queue via `idb` | Best DX for MV3: hot reload, manifest generation, and one codebase for the Firefox and Edge builds (`browser.*` API through WXT, never raw `chrome.*`). |
| Dashboard | **Vite + React 19 + TanStack Router/Query + shadcn/ui + Tailwind v4** | A logged-in SPA needs no SSR. The API serves it as static files, so it's same-origin with simple cookies and no CORS. |
| Lint/format | **Biome** | One fast tool for lint and format. |
| Tests | **Vitest** (with SWC for Nest decorators), **supertest** against the Nest app, **Testcontainers** (Postgres), **fast-check** (rule properties), **web-ext + Selenium/geckodriver** under the Playwright test runner (Firefox e2e, the primary suite), **Playwright** (loads the unpacked Edge/Chromium build for the Edge smoke) | The full demo runs as an automated e2e test in CI on Firefox; Edge gets an automated smoke test (and Chrome too, after v1). |
| Deploy | **docker compose**: `postgres`, `api`, `worker` (same image, different command). Optional **Caddy** for TLS on a VPS. | One documented command. |

Pin exact versions when scaffolding in M0, using releases at least 14 days old. The dev Postgres runs on **port 5433** so it never touches a Postgres already on 5432.

---

## 3. Architecture

```text
┌─── Browser extension (Firefox → Edge, MV3, WXT) ─────┐        ┌──── other sources (v1: any HTTP client) ───┐
│ tabs/idle listeners → normalize → sanitize URL       │        │ curl / scripts / future GitHub integration │
│ → collect-rules (shared engine, cached, fail-closed) │        └───────────────────┬────────────────────────┘
│ → IndexedDB queue → batch flush (alarms + backoff)   │                            │
└───────────────────────────┬──────────────────────────┘                            │
                            ▼  Bearer pa_ing_…                                     ▼
┌──────────────────────────────── apps/api (NestJS) ───────────────────────────────────────────────┐
│ POST /v1/ingest/events                                                                            │
│   auth key → envelope + per-type payload validation → collect-rules again (defense in depth)      │
│   → process-rules (tag, retention) → ONE tx: INSERT … ON CONFLICT DO NOTHING + ingestion log      │
│   → per-item result {accepted | duplicate | dropped(rule) | rejected(error)}                       │
│ GET /v1/ingest/config  (rules + default policy, ETag) · POST /v1/ingest/heartbeat                  │
│ Platform API (session cookie) · Read API (session or pa_read_ key) · /v1/me/:slug saved queries  │
│ Serves the dashboard SPA as static files                                                          │
└──────────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                           ▼
             PostgreSQL 18 — app tables + pgboss schema  ◄──  worker: retention · bulk delete · export
```

### Key principles

1. **Privacy filtering happens before data leaves the browser.** Collect-stage rules run in the extension, so a denied site never generates a request. The server re-applies them anyway, because the extension is untrusted and rules can change while events sit in the queue. One exception, chosen in M4-05 (`docs/rule-format.md`, open item 1): an event from a browser-extension integration that names the server's current rule-set version (at least 1, with collect rules, and only when an `allow` rule reads a field that a collect `coarsen` or `redact` rewrites) was already decided by the same rules in the extension, so the server does not ask the default policy again. Every other event (another version, version 0, an `http` source, no `meta`) gets the full evaluation, and a `drop` rule that decides still drops.
2. **One rule engine runs on both sides.** `packages/rules` is pure TypeScript with no Node or DOM APIs, so the extension, server and "test rule" preview all give identical answers.
3. **Delivery is at-least-once, storage is effectively-once.** The extension assigns each event a UUIDv7 when it's captured. A unique constraint on `(user_id, integration_id, client_event_id)` turns retries into `duplicate` results instead of new rows. The system doesn't claim exactly-once.
4. **Fail closed.** If there are no rules, invalid rules, or an engine error, nothing is collected or stored, and an error is surfaced. A misconfiguration must never silently widen collection.
5. **Dropped events are never stored.** Only counters are kept, per rule, per day, with no payload. Even "what we didn't keep" doesn't leak.

---

## 4. Data model (v1)

```text
users, sessions, accounts, verification — Better Auth (users also carry time_zone, an IANA name, default 'UTC')
integrations   id, user_id, kind ('browser-extension' | 'http'), name, default_policy ('deny'|'allow'),
               status ('active'|'revoked'), last_seen_at, last_heartbeat jsonb (queue depth, version)
api_keys       id, user_id, kind ('ingest'|'read'), integration_id?, prefix, hash, scopes jsonb,
               name? (read keys), restriction jsonb? (read keys: {sources?, types?}),
               endpoint_id?, created_at, last_used_at, revoked_at
pairing_codes  code_hash, user_id, integration_id, expires_at (10 min), used_at
rule_sets      user_id, version (int, bumps on every change), updated_at
rules          id, user_id, name, enabled, priority, stage ('collect'|'process'), definition jsonb, ...
rule_history   rule_set_version, snapshot jsonb   — needed so an old event's trace stays explainable
events         id uuidv7, user_id, integration_id, client_event_id, type, type_version,
               occurred_at, received_at, origin ('collected'|'imported'|'derived'),
               data jsonb, tags text[], trace jsonb, expires_at
               UNIQUE (user_id, integration_id, client_event_id)
               INDEX (user_id, occurred_at DESC, id) · (user_id, type, occurred_at) · (expires_at)
ingestion_log  user_id, integration_id, bucket (hour), accepted, duplicate, dropped, rejected,
               by_reason jsonb  (rule ids / error codes → counts), no payloads
retention_policies  user_id, match (source/type), days
bulk_deletions user_id, kind (events/integration), filter jsonb, status, total, deleted, finished_at (M6-03: progress of a delete-by-filter job; no event data)
endpoints      id, user_id, slug, definition jsonb (saved query), enabled, created_at, updated_at
exports        id, user_id, status, filter jsonb, file_path, event_count, size_bytes, created_at, finished_at, expires_at  (M6-05: the files live in EXPORT_DIR/<id>/, never in the database)
```

**Event envelope** (what a source sends):

```json
{
  "id": "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b",
  "type": "browser.page_visited",
  "typeVersion": 1,
  "occurredAt": "2026-10-13T10:05:00.000Z",
  "data": { "domain": "github.com", "path": "/Mohaned178/IdentiK", "transition": "link" },
  "meta": { "ruleSetVersion": 7, "client": "pa-extension/0.1.0" }
}
```

The server sets the source (`integration_id`) from the key, never from the body, and adds `receivedAt`. If `occurredAt` is more than 5 minutes in the future, the event is clamped and flagged. If it's older than the retention window, the event is rejected.

**v1 browser event types** (each one has a Zod schema in `packages/contracts`):

| Type | Data | Notes |
| --- | --- | --- |
| `browser.page_visited` | domain, path, transition, tabRef | Navigation committed in a tab. `tabRef` is a per-session random id, not the browser's tab id. |
| `browser.focus_segment` | domain, path, startedAt, endedAt, durationMs | A **closed interval** of real attention. It ends on tab switch, window blur, idle (60 s) or lock. Time-on-site is the sum of these intervals, so lost events can't cause runaway durations. |
| `browser.tab_opened` / `browser.tab_closed` | tabRef, domain? | |
| `browser.session_started` / `browser.session_ended` | reason (start: startup/resume; end: idle/lock/shutdown/recovered) | A session ends after 30 minutes idle. |

Page titles, full URLs, form contents, keystrokes and incognito activity are **never** collected in v1. Incognito / private windows also require the user to opt in at the browser level, and the extension ignores them even then.

---

## 5. Rule format

```json
{
  "name": "Track GitHub, but not settings pages",
  "enabled": true,
  "priority": 10,
  "stage": "collect",
  "when": {
    "source": ["browser-extension"],
    "type": ["browser.*"],
    "all": [
      { "field": "data.domain", "op": "domain_matches", "value": "github.com" }
    ],
    "none": [
      { "field": "data.path", "op": "starts_with", "value": "/settings" }
    ]
  },
  "then": [{ "action": "allow" }]
}
```

- **Conditions:** `source`, `type` (with `*` glob), and `all`/`any`/`none` lists of `{field, op, value}`. Ops: `eq`, `neq`, `in`, `starts_with`, `ends_with`, `contains`, `domain_matches` (exact or `*.example.com`), `matches_glob`, `gt/lt` for numbers and times, `exists`. **No regex in v1** (to avoid ReDoS) and **no code execution, ever**.
- **Collect-stage actions** (run in the extension and on the server): `allow`, `drop` (terminal), `redact` (remove a field), `coarsen` (path → first N segments, or path → none), `keep_query` (opt in to the full URL for this match).
- **Process-stage actions** (server only): `tag`, `set_retention` (days). `forward` (webhook) is reserved in the schema and ships in v1.1.
- **Evaluation:** rules are sorted by priority. Transforms apply in order. The **first terminal action decides** the outcome. If no rule decides, the integration's `default_policy` decides (deny for a new extension). On a conflict at the same priority, **drop beats allow**.
- **Explainability:** every stored event carries `trace = {ruleSetVersion, matched: [{ruleId, actions}], decidedBy}`. The dashboard shows "why is this here", and the popup shows "this page: collected / blocked by rule X" for the current tab using the same engine.
- **Safety:** the Zod schema rejects invalid rules on save, including unknown fields for the selected types. Every change bumps `rule_sets.version`. The extension refetches rules with an ETag and stops capturing if it can't load a valid set.

---

## 6. API surface (v1)

Errors use RFC 9457 `application/problem+json`. Lists use keyset cursors on `(occurred_at, id)`. OpenAPI is served at `/docs`, and `/docs` is public: it describes request shapes only and holds no data (ADR 0001, deviation 6).

**`source` means two things.** On `GET /v1/events?source=` and in a read key's `restriction.sources` it is an **integration id** (a uuid). In a saved query's `when.source` it is an **integration kind** (`browser-extension`, `http`), the same as in a rule's `when`.

**Known exception:** the routes Better Auth serves itself under `/api/auth/*` return Better Auth's own JSON error body, not problem+json. The responses we add in front of it (refused signup `auth.signup_disabled`, oversized body `http.payload_too_large`, unexpected 500) are still problem+json. See `docs/self-hosting.md`.

| Auth | Endpoint | Purpose |
| --- | --- | --- |
| none | `GET /healthz`, `GET /readyz` | Liveness, and DB + queue readiness |
| none | `GET /v1/setup/status` | Dashboard first-run probe: `needsSetup` and `signupOpen` booleans only |
| pairing code | `POST /v1/pair` | Exchange a one-time code for an ingest key |
| ingest key | `POST /v1/ingest/events` | Batch of up to 100 events and 256 KB. Returns per-item results. |
| ingest key | `GET /v1/ingest/config` | Collect rules, rule-set version and the integration's `defaultPolicy`, with ETag. `browser-extension` integrations only; an `http` key gets `403 ingest.config_unsupported` |
| ingest key | `POST /v1/ingest/heartbeat` | Queue depth, oldest queued age, version |
| session | `/v1/integrations` (CRUD, pairing code, revoke) | Connect and disconnect sources |
| session | `/v1/rules` (CRUD), `POST /v1/rules/test` | Manage rules and dry-run them against a sample event |
| session | `DELETE /v1/events` (ids: 200; filter: 202 job), `GET /v1/events/deletions/:id`, `DELETE /v1/integrations/:id/data`, `/v1/exports` (`POST` 202 job, `GET` list, `GET /:id`, `GET /:id/download` NDJSON.gz, `GET /:id/manifest`; 409 `export.not_ready`, 410 `export.expired`), `/v1/retention` | Data management |
| session | `/v1/keys`, `/v1/endpoints` (CRUD, `POST /v1/endpoints/:id/rotate-key`, `POST /v1/endpoints/preview`) | Read keys and saved queries. Creating or rotating an endpoint answers with its `endpoint:<id>` key, once |
| session | `GET /v1/settings`, `PATCH /v1/settings`, `GET /v1/settings/time-zones` | The user's time zone, which the activity aggregates cut days in. `PATCH` checks the name against the database (`pg_timezone_names`, not Node's list: `400 settings.time_zone_unsupported`), and `time-zones` lists the names it accepts |
| session | `DELETE /v1/account` | Delete the account and all its data. The body carries the current password and `confirm: "delete my account"`; `204` clears the session cookies, `403 account.password_invalid`, `429 account.rate_limited` (M6-04). One transaction; modules that keep data outside the database register an `AccountDeletionStep` that runs first |
| session | `GET /v1/diagnostics` | Ingestion log, integration last-seen, queue backlog, job failures, and drop counts per rule over the window (M4-07) |
| session or read key | `GET /v1/events?source=&type=&from=&to=&domain=&cursor=` | Raw events |
| session or read key | `GET /v1/activity/daily?from=&to=`, `GET /v1/activity/domains?from=&to=&limit=` | Aggregates computed with SQL at query time (no materialized tables needed at this volume). Active time is the sum of `focus_segment` durations, visits count `page_visited`; an event counts toward the day of its `occurred_at` in the user's time zone. Default range is the last 7 days, at most 90. Needs `activity:read` for a key. |
| read key scoped to it | `GET /v1/me/:slug` | A user-defined saved query |

**Saved query definition:** source and type filters, a relative time window (`today`, `this_week`, `last_n_days`), the same condition language as rules, a field allowlist for projection, and an optional aggregate (`count_by_day`, `count_by_domain`, `duration_by_domain`). Hard limits: 1,000 rows and a 2-second `statement_timeout`. An aggregate-only endpoint can never return raw events. That covers "share my browsing stats without individual visits". The exact format is `docs/saved-queries.md`.

---

## 7. Extension behavior

- **Permissions:** `tabs`, `idle`, `storage`, `alarms`. The API origin is requested at runtime from `optional_host_permissions` when the user enters the server URL. There are no content scripts and no `<all_urls>`.
- **Connect flow:** in the dashboard, choose "Add browser extension" to get a 10-minute pairing code. In the popup, enter the server URL and code. The extension requests the origin permission, calls `POST /v1/pair`, stores the key, and fetches the config.
- **Queue:** events are persisted to IndexedDB at capture time, because the MV3 background (a service worker on Edge, an event page on Firefox) can be suspended at any moment. A flush runs on an alarm and on new events, in batches of 100, with exponential backoff and jitter. The queue is capped at 50k events or 14 days. If it overflows, the oldest events are dropped **and the drop count is shown and reported in the heartbeat**, so nothing is lost silently.
- **Server responses:** a `401` or a revoked key puts the extension in the "Disconnected" state, which stops capture and offers "clear local queue". A `4xx` for a single item removes just that item and logs it locally. `5xx` and network errors cause a retry.
- **Popup:** connection state, pause/resume, queue depth, last successful sync, dropped count, the current tab's collection verdict and why, and a link to the dashboard.

---

## 8. Security and privacy checklist (v1 must-haves)

- Every query is scoped by `user_id` from the auth context through repository helpers. **A cross-tenant test suite** checks that user B's session and keys get a 404 for every one of user A's resources. Postgres RLS is planned as hardening in v1.1.
- Keys are hashed at rest and shown once. Each key has a prefix for identification and a `last_used_at`. Revocation takes effect immediately.
- Logs never contain payloads, URLs, domains or keys. pino uses a redaction list, and a test asserts it.
- Dashboard: secure, HttpOnly, SameSite=Lax cookies, CSRF protection on mutations, and a rate limit on login and pairing.
- Signups can be disabled after the first account exists (self-host admin setting).
- Deletion is a hard delete. The docs state that database backups keep deleted data until they rotate.
- Event types say which part of the system produced them (`origin` + integration), so collected, imported and derived data stay distinguishable.

---

## 9. Repository layout

```text
personal-api/
  apps/api/            NestJS: src/main.ts (HTTP) + src/worker.ts (standalone app context, pg-boss consumers)
                       src/modules/{auth,integrations,ingest,rules,events,activity,endpoints,keys,
                                    retention,exports,diagnostics} · src/platform/{db,jobs,logging,config}
  apps/web/            React dashboard (the API serves WEB_DIST_DIR, default apps/web/dist; release path settled in M7-05)
  apps/extension/      WXT MV3 extension (firefox-mv3 + chrome-mv3 builds for Edge)
  apps/e2e/            Firefox e2e (web-ext + Selenium, primary) + Edge smoke (Playwright, unpacked Chromium build) + local fixture site
  packages/contracts/  Zod: envelope, event types, API DTOs, rule + saved-query schemas
  packages/rules/      Pure rule engine (no Node/DOM deps). The saved-query schema and validator live in contracts (M5-04).
  packages/tsconfig/   Shared TS config
  docs/                PLAN.md, self-hosting.md, event-types.md, rule-format.md, saved-queries.md, api.md, adr/
  docker-compose.yml   postgres (5433), api, worker
  CLAUDE.md
```

---

## 10. Milestones and tasks

Each milestone ends with something demoable, green CI and a short demo note in the PR.

**Legend:** each tag is `[model · effort]`. You never pick these yourself: `/task` and `/milestone` read the tag and launch the right model at the right effort (see §12).

- **Model:** `H` Haiku: setup, config, docs, simple tasks. `S` Sonnet: implementation and **all tests**. `O` Opus: **reviews only** (milestone reviews and the security pass) and helping when Sonnet is stuck. Opus does not implement (rule of 2026-10-16).
- **Effort:** `low` is mechanical work with an obvious answer. `medium` is normal feature work. `high` covers tricky edge cases, concurrency, security-adjacent work or fiddly tooling; `xhigh` is the hardest security-critical work. Sonnet implements at any of the four efforts; tests use Sonnet at `low` or `medium`. There are no per-task reviews: Opus reviews at `Mx-R` and the security pass (`high` or `xhigh` as tagged). If Sonnet is stuck, the coordinator tells the user, who lets Opus join. `max` isn't used by default.
- **DeepSeek is not used** (rule of 2026-10-17). Claude implements every task inline in the session, with no per-task subagents; only `Mx-R` reviews launch a subagent (Opus).

- On `high`/`xhigh`/security-touching tasks, **the tests are written first** from the "done when" criteria, then the implementation continues until they pass. The tests stay independent of the code they check.
- Tasks are numbered `Mx-NN`, with one branch per task (`mx-nn-short-name`).
- M0 to M3 tasks are concrete. M4 to M7 have firm scope, but get refined at the start of each milestone.

### Who implements what (open tasks)

| Implementer | Tasks | Review |
| --- | --- | --- |
| **Sonnet** (any effort) | M2-05, M2-08 · M4-00, M4-01, M4-02, M4-03, M4-05, M4-06, M4-09 · M5-01, M5-04, M5-06 · M6-02, M6-04, M6-06 · M7-01, M7-02, M7-03, plus the tests (low/medium) for every high-effort and `{deepseek}` task, plus fixing review findings | Opus at `Mx-R` only |
| **Opus · high / xhigh** (review only) | M2-R, M3-R, M4-R, M5-R, M6-R, M7-04, M7-R | — |


### M0: Foundations and spikes

- [x] **M0-01 [H · medium] Monorepo scaffold:** pnpm workspace, Turborepo, `packages/tsconfig`, Biome, `.editorconfig`, `.gitignore`, `.nvmrc` (24), `packageManager` + `engines` pins, TypeScript 6.0.x (not 7: Nest/Better Auth peers), `minimumReleaseAge: 20160` and a dependency build-script allowlist in `pnpm-workspace.yaml`, and root scripts for install/lint/format/typecheck/test/build (later scripts are added by the task that creates their target). *Done when:* `pnpm install && pnpm lint && pnpm typecheck && pnpm test` passes locally on Windows (Linux is proven by M0-02). The PR has no CI yet, so say so.
- [x] **M0-02 [H · medium] CI:** GitHub Actions on PRs and main: install (pnpm version from `packageManager`, Node from `.nvmrc`, pnpm cache), lint, typecheck, unit tests on ubuntu-latest and windows-latest. Later tasks add jobs: integration in M0-05, e2e in M0-09. *Done when:* the workflow passes on this task's PR on both OSes.
- [x] **M0-03 [H · low] Local infra:** `docker-compose.yml` (pinned `postgres:18.x` image, host port **5433**, named volume mounted at `/var/lib/postgresql` per the PG 18+ image layout, `pg_isready` healthcheck), `.env.example` (`DATABASE_URL` on 5433), `pnpm db:up` (`docker compose up -d --wait`) / `db:down`. *Done when:* `pnpm db:up` exits only once the container is healthy and `docker compose exec postgres psql -c 'select uuidv7()'` succeeds.
- [x] **M0-04 [S · medium] NestJS skeleton (`apps/api`):** NestJS 11.x on Express 5 (Nest 12 is blocked by nestjs-zod's peers), Vitest + unplugin-swc for decorators, Zod-validated config (rejects a `DATABASE_URL` on port 5432), `nestjs-pino` with a redaction list, an RFC 9457 problem+json filter, `/healthz`, and `/readyz` backed by a readiness-check registry. *Done when:* supertest checks `/healthz`; `/readyz` returns 503 when a registered check fails; a test shows redacted fields never reach log output; config rejects port 5432.
- [x] **M0-05 [S · medium] Database layer:** Drizzle schema folder, drizzle-kit migrations, `pnpm db:migrate` / `db:generate`, a Testcontainers helper using the same image tag as compose, the `pnpm test:int` script, a DB readiness check, and the CI integration job. *Done when:* an integration test starts Postgres, migrates and queries; `/readyz` is 503 with the DB down and 200 with it up; the CI integration job is green.
- [x] **M0-06 [S · medium] Jobs:** a `JobsModule` around pg-boss 12 (explicit `createQueue`, graceful stop on shutdown), `src/worker.ts` as a Nest standalone app context, `pnpm worker`, and a queue readiness check. *Done when:* an integration test enqueues a no-op job and the worker completes it, and `/readyz` reports the queue.
- [x] **M0-07 [O · high] Dashboard auth:** Better Auth 1.7.x (Drizzle adapter) with its tables generated into the Drizzle schema and migrated, mounted in Nest via `@thallesp/nestjs-better-auth` (handles the raw-body / `bodyParser: false` issue) unless the builder justifies hand-rolling it; signup/login/logout/`me`, `SessionGuard`, `ALLOW_SIGNUP`. *Done when:* tests cover the full login flow, cookies are HttpOnly + SameSite=Lax, a guarded route returns 401 without a session, the first account can always sign up, and later signups are blocked when `ALLOW_SIGNUP=false`.
- [x] **M0-08 [H · low] Extension skeleton (`apps/extension`):** WXT 0.21.x (`wxt prepare` on postinstall), MV3 manifest with only `tabs`, `idle`, `storage`, `alarms` + `optional_host_permissions`, and a placeholder popup. *Done when:* `pnpm --filter extension build` succeeds and a unit test of the built `.output/chrome-mv3/manifest.json` asserts exactly those permissions, no `host_permissions` and no `content_scripts`. Loading unpacked is proven in M0-09.
- [x] **M0-09 [S · high] Spike B, e2e harness:** Playwright (bundled Chromium, because branded Chrome 137+ ignores `--load-extension`) loads the unpacked extension against a local fixture site (`apps/e2e`), plus `pnpm test:e2e` and a CI e2e job. *Done when:* it runs headless in CI, reads the extension's state from its service worker, and can stop/restart the service worker through CDP.
- [x] **M0-10 [O · high] Spike A, MV3 lifecycle:** a throwaway prototype of capture, an IndexedDB queue and focus segments under forced service-worker termination, idle, lock, window blur and browser restart, using the M0-09 harness. *Done when:* a Playwright test kills the service worker 20× during capture with zero lost events, scripted blur/tab-switch segments are off by less than 2 s, browser restart is covered by a persistent-context relaunch, idle and lock follow a written manual protocol, and `docs/adr/0002-mv3-state-persistence.md` records the results and the go/no-go.
- [x] **M0-11 [H · low] Docs:** every command in `CLAUDE.md` either runs or is marked "(from Mx-NN)" (for example web in `pnpm dev` until M3-01), and `docs/adr/0001-stack.md` records the pinned versions and the deviations (Nest 11 over 12, TS 6 over 7, Node 24 now Maintenance LTS, revisit Node 26 at M7).
- [x] **M0-R [O · high] Milestone review** (`/code-review` + `/security-review`). Auth, cookies and log redaction land in M0.

### M1: Ingestion API

- [x] **M1-01 [O · high] Contracts:** scaffold `packages/contracts` (`@personal-api/contracts`, Zod 4.6.5, built `dist` + `exports` usable from the CJS API and the ESM extension), a strict envelope schema (`id` accepts any RFC 9562 UUID), an event-type registry (`type@version` → strict Zod schema), the v1 browser types from §4 (`path` without `?`/`#`, lowercase `domain`, `focus_segment` bounds ≤ 30 min, `transition` optional), the ingest batch request (≤ 100) and per-item result schemas, and stable error codes (`ingest.envelope_invalid`, `ingest.type_unknown`, `ingest.type_version_unknown`, `ingest.payload_invalid`) returned by a non-throwing `parseEvent()`. *Done when:* unit tests cover each code, unknown keys (including `userId`/`integrationId`/`receivedAt`) are rejected in the envelope and in `data`, and both `apps/api` and `apps/extension` import the package in a test that passes under `pnpm build && pnpm typecheck && pnpm test`.
- [x] **M1-02 [S · medium] Schema:** `integrations`, `api_keys`, `events` and `ingestion_log` tables and migrations, following §4. Every tenant table has `user_id text NOT NULL` → `user(id) ON DELETE CASCADE`. `integrations.default_policy` defaults to `'deny'`. `api_keys`: unique index on `hash`, and a CHECK that `kind='ingest'` ⇒ `integration_id NOT NULL` (`endpoint_id` waits for M5). `events`: the dedupe key and indexes from §4; `client_occurred_at timestamptz NULL` holds the client's original value when `occurred_at` was clamped (non-null is the future-timestamp flag); `trace` nullable until M4; `expires_at` nullable until M6-01. `ingestion_log`: UNIQUE `(user_id, integration_id, bucket)` for the hourly upsert. *Done when:* an integration test migrates and shows a duplicate `(user_id, integration_id, client_event_id)` insert is a no-op under `ON CONFLICT DO NOTHING`; the api_keys CHECK rejects an ingest key without an integration; deleting a user cascades; `pnpm db:generate` finds nothing new afterwards.
- [x] **M1-03 [O · xhigh] API keys and tenant scoping:** key generation (`pa_ing_`/`pa_read_` + base64url of 32 random bytes; store a short display prefix and the SHA-256 hash; look up by hash). Turn the session-only `AuthContext` into a discriminated union (`session` | `ingest` carrying `userId`, `integrationId`, `keyId`); `CurrentAuth` fails closed on the wrong kind. `IngestKeyGuard` reads only `Authorization: Bearer pa_ing_…` and ignores cookies. A tenant-scoped repository helper that won't run a query without `userId`. `last_used_at` updated at most once per interval. The two-user fixture in `apps/api/test/` (each user gets a session cookie, an `http` integration and an ingest key, seeded through the service layer), reused by every later milestone. *Done when:* unknown, malformed, revoked, revoked-integration and `pa_read_` keys all get the same 401 problem+json (`auth.invalid_key`, no oracle); a session cookie can't pass `IngestKeyGuard` and an ingest key can't pass `SessionGuard`; no repository method can be called without a user scope; the `last_used_at` interval is proven under a fixed clock.
- [x] **M1-04 [S · high] Integrations module:** add `nestjs-zod` (check the peer range and the 14-day rule, per ADR 0001 §6) with a global validation pipe; failures become 400 problem+json `request.invalid` whose issues never echo input (reuse contracts' `toContractIssues`). Integration DTOs go in `packages/contracts`. Session routes: create, list, get, rename, revoke. Creating an `http` integration returns its ingest key once. Revoking also revokes its keys. No hard delete (M6-03). `browser-extension` creation comes with M2-01. *Done when:* the key appears only in the create response (list/get never show key or hash; only the hash is stored); a revoked integration's key gets 401 on the very next request; 401 without a session; cross-tenant get, rename and revoke return 404 (two-user fixture); unknown body keys get 400 `request.invalid`.
- [x] **M1-05 [O · xhigh] `POST /v1/ingest/events`:** a 256 KB JSON body limit on this route only (extend `BodyParserModule`; everything else stays 100 KB). Batch shape via `ingestBatchRequestSchema`, each item via `parseEvent()`. Events older than a fixed 90-day window (until M6) are rejected with a new contracts code `ingest.occurred_at_too_old`. Timestamps more than 5 minutes in the future are clamped to `receivedAt`, original kept in `client_occurred_at`. One transaction does `INSERT … ON CONFLICT DO NOTHING … RETURNING` and the hourly `ingestion_log` upsert (`by_reason` counts by error code). Per-item results come from `RETURNING`, never a prior SELECT. No rule evaluation until M4-05: `dropped` is never returned in M1 and every valid event is stored (M4-05 added rule enforcement here). *Done when:* the same batch sent 3 times gives 1 row; a batch with the same id twice gives `accepted` then `duplicate`; partly-invalid batches return the right per-item code in request order; whole-request failures are a single problem+json (over 256 KB → 413 `http.payload_too_large`; empty, over 100 events or unknown top-level keys → 400 `ingest.batch_invalid`; invalid JSON → 400); clamping proven under a fixed clock; `ingestion_log` counts match the results; cross-tenant: user B's key only writes to B's own integration.
- [x] **M1-06 [S · low] Heartbeat:** strict heartbeat request schema in `packages/contracts` (`queueDepth`, `oldestQueuedAgeMs`, `droppedCount`, `clientVersion`); `POST /v1/ingest/heartbeat` stores it as `last_heartbeat`; `last_seen_at` is bumped by both heartbeat and ingest, at most once per interval. *Done when:* a valid heartbeat updates only the caller's integration; unknown keys get 400; a revoked key gets 401.
- [x] **M1-07 [S · high] Adversarial test suite** (each route task already ships its own cross-tenant test): N parallel posts of the same batch give 1 row per id, exactly one `accepted` per id and consistent `ingestion_log` totals; revoking a key mid-stream takes effect on the next request; a cross-tenant sweep over every M1 route with the two-user fixture; a `captureOutput()` test showing ingest and heartbeat never log a domain, path, key or hash.
- [x] **M1-08 [H · low] Docs:** make `pnpm --filter api start` load `../../.env` the way `worker` does (cross-platform) and update the CLAUDE.md command list; `docs/event-types.md` covering the v1 types and fields; `docs/api.md` with `curl` for sign up (with `Origin`), create an `http` integration, ingest a batch, heartbeat, plus the error codes. *Done when:* every curl example was run against a local API, or the PR says it wasn't (Docker off).
- [x] **M1-R [O · xhigh] Milestone review** (`/code-review` + `/security-review`). M1 introduces API keys, tenant scoping and the ingest transaction, which §10 lists as privacy-critical.

### M2: Extension capture and delivery

Targets changed on 2026-10-14: Firefox + Edge (free stores only) instead of Chrome. Every M2 extension task must build and pass its unit tests for both `firefox-mv3` and `chrome-mv3`. (On 2026-10-18 the order became Firefox first, then Edge, then Chrome after v1; see §2 and M4-00.)

- [x] **M2-00a [S · medium] Cross-browser build:** WXT targets `firefox-mv3` and `chrome-mv3` (`build`, `build:firefox`, `zip` for both), `browser_specific_settings.gecko` (id + `strict_min_version`) and Firefox `data_collection_permissions` in the manifest, and the M0-08 manifest test extended to both outputs. Rename the integration kind `chrome-extension` → `browser-extension` (contracts, schema, migration, tests). *Done when:* both builds succeed in CI, both manifest tests assert exactly `tabs`, `idle`, `storage`, `alarms` + `optional_host_permissions`, no content scripts, incognito not allowed; `pnpm test:int` covers the migrated constraint.
- [x] **M2-00b [O · high] Spike C, Firefox lifecycle:** re-run the Spike A design (ADR 0002 option B) on a Firefox MV3 event page with web-ext + Selenium/geckodriver: forced background suspension during capture, idle, lock (Firefox may not report `locked`), window blur and browser restart. *Done when:* an automated test suspends/reloads the background 20× during capture with zero lost or duplicated events (or the PR explains why Firefox can't force this and what was measured instead), blur/tab-switch segments are off by less than 2 s, and ADR 0002 gains a Firefox section with go/no-go and any per-browser differences M2-04/M2-05 must handle.
- [x] **M2-00c [S · high] Firefox e2e smoke harness:** web-ext + Selenium/geckodriver loads the `firefox-mv3` build against the local fixture site, plus a CI job. *Done when:* it runs headless in CI and can read the extension's stored state.

- [x] **M2-01 [S · high] Pairing (API):** a `pairing_codes` table, `POST /v1/integrations/:id/pairing-code` (session) and `POST /v1/pair` (single use, 10-minute expiry, rate limited). *Done when:* tests cover expired, reused and brute-force-throttled codes.
- [x] **M2-02 [S · medium] Connect UI (extension):** server URL input, `browser.permissions.request` for that origin (inside the click handler: Firefox requires a user gesture), pairing, key stored in `browser.storage.local`, and a disconnect button.
- [x] **M2-03 [S · high] URL sanitizer:** keep domain + path, strip query and fragment, normalize IDN and case, and ignore non-http(s) schemes (`chrome://`, `edge://`, `moz-extension://`, `chrome-extension://`, `file://`, `about:`). *Done when:* property tests show the output never contains `?` or `#`.
- [x] **M2-04 [O · high] Capture engine:** listeners → `page_visited`, `tab_opened/closed`, a `focus_segment` state machine, session start and end, incognito ignored, state persisted following ADR 0002 (Spike A + Spike C). *Done when:* unit tests with mocked `browser.*` APIs and fake timers pass, covering the idle, lock and blur cases, including Firefox's differences recorded by Spike C.
- [x] **M2-05 [S · high] Persistent queue and sync:** IndexedDB store, alarm-driven batch flush, backoff + jitter, per-item result handling, the 50k / 14-day cap with a reported drop counter, and 401 → disconnected. *Done when:* tests cover network failure, partial batch failure and a background restart mid-flush (service worker on Edge, event page on Firefox) with no loss and no duplicates.
- [x] **M2-06 [S · medium] Popup v1 and heartbeat:** connection state, pause/resume, queue depth, last sync, dropped count, and a heartbeat on an alarm.
- [x] **M2-07 [S · low] Temporary allow list** in extension storage (replaced in M4).
- [x] **M2-08 [S · high] e2e:** Playwright/Chromium: pair → visit fixture → events in the DB; go offline → reconnect → nothing lost or duplicated. Firefox smoke (M2-00c harness): pair → visit fixture → events in the DB.
- [x] **M2-R [O · high] Milestone review.**

### M3: Dashboard v0

- [x] **M3-01 [H · medium] `apps/web` scaffold:** Vite, React 19, TanStack Router + Query, Tailwind v4 and shadcn/ui. The API serves the build statically, with a dev proxy to the API.
- [x] **M3-02 [S · medium] Auth pages:** first-run setup, signup, login, logout, and route guards.
- [x] **M3-03 [S · medium] Integrations page:** list, add extension (shows the pairing code with a countdown), add HTTP integration (key shown once), and revoke with confirmation.
- [x] **M3-04 [S · medium] Platform events API (session):** list with filters + keyset cursor, get one, delete by ids, including cross-tenant tests.
- [x] **M3-05 [S · medium] Events browser UI:** virtualized table, filters (source, type, time range, domain), a detail drawer (JSON, origin, integration) and multi-select delete.
- [x] **M3-06 [S · medium] Diagnostics API and Health page:** last seen per integration, queue depth from heartbeats, and accepted/duplicate/dropped/rejected charts.
- [x] **M3-07 [H · low] UI polish:** empty, loading and error states, and copy.
- [x] **M3-R [O · medium] Milestone review.**

### M4: Rules

- [x] **M4-00 [S · medium] Firefox becomes the primary e2e:** bring the Selenium/geckodriver harness to parity with the Playwright one (pairing, fixture visits, DB reads, offline and reconnect), port the M2-08 offline → reconnect test to Firefox, and keep Edge/Chromium as a smoke suite (pair → visit fixture → events in the DB). Rename the scripts so `pnpm test:e2e` runs Firefox and `test:e2e:edge:smoke` runs Edge, and update CI and `CLAUDE.md`. *Done when:* CI runs the Firefox suite (including offline → reconnect, with nothing lost or duplicated) and the Edge smoke as separate jobs, both green.
- [x] **M4-01 [S · high] Rule format:** the Zod schema in `contracts`, a per-type field registry (which fields conditions may use), and a draft of `docs/rule-format.md`.
- [x] **M4-02 [S · high] Engine (`packages/rules`):** `compileRuleSet(input)` validates and sorts a rule set once per version, and `evaluate(event, compiledSet, policy, {source, process?})` returns `allow` (with `event`, `tags`, `retentionDays`, `keepQuery`, `trace`), `drop` (with `trace`, no event) or `error`, with the ops, actions, priority and drop-beats-allow semantics from §5. Pure, with no I/O.
- [x] **M4-03 [S · high] Engine tests:** table tests per op and action, plus fast-check properties (drop dominance, determinism, idempotent transforms, invalid input → fail closed). "Idempotent" means the event is stable when evaluated again; the decision is not always stable (open item 1 in `docs/rule-format.md`), so state which one each property checks.
- [x] **M4-04 [S · medium] Rules API:** CRUD, rule-set versioning, `rule_history` snapshots, validation on save, and `POST /v1/rules/test`.
- [x] **M4-05 [S · high] Server enforcement:** per-user rule-set cache invalidated by version, collect then process stages at ingest, stored traces, per-rule drop counters, and engine errors → `rejected(rule_error)`.
- [x] **M4-06 [S · high] Extension rule sync:** `GET /v1/ingest/config` with ETag, alarm-based sync, fail closed when rules are missing or invalid, removal of the M2-07 list, and the current-tab verdict in the popup.
- [x] **M4-07 [S · medium] Rules UI:** list with priority ordering, form builder, JSON toggle with inline errors, test against a sample event, and drop counts.
- [x] **M4-08 [S · medium] Explainability:** the "why is this here" view on events, and onboarding starter templates.
- [x] **M4-09 [S · high] e2e (Firefox):** demo steps 3 and 7 (add a rule → collected; change the rule → later events behave differently).
- [x] **M4-R [O · xhigh] Milestone review** (`/code-review` + `/security-review`).

### M5: Query API and user endpoints

- [x] **M5-01 [S · high] Read keys:** scopes (`events:read`, `activity:read`, `endpoint:<id>`), optional source/type restriction, `ReadKeyGuard`, and a keys UI.
- [x] **M5-02 [S · medium] `GET /v1/events`** for a session or read key, with scope filtering applied.
- [x] **M5-03 [S · medium] Aggregates:** `/v1/activity/daily` and `/v1/activity/domains` (time from focus segments), plus a user time zone setting.
- [x] **M5-04 [S · high] Saved-query compiler:** definition schema → parameterized Drizzle query, a field-allowlist projection, aggregate modes, row limits, `statement_timeout`, and aggregate-only enforcement.
- [x] **M5-05 [S · medium] Endpoints:** CRUD, `GET /v1/me/:slug`, and a UI with live preview + a copyable `curl`.
- [x] **M5-06 [S · high] Tests:** injection attempts through field names and values, limit and timeout, scope escalation (endpoint A's key calling B or `/events`), and cross-tenant.
- [x] **M5-07 [H · low] OpenAPI** at `/docs`, and `docs/api.md`.
- [x] **M5-R [O · xhigh] Milestone review** (`/code-review` + `/security-review`).

### M6: Data lifecycle

- [x] **M6-01 [S · medium] Retention policies:** table, API and UI. `expires_at` is set at insert, with precedence rule `set_retention` > type policy > source policy > default 90 days.
- [x] **M6-02 [S · high] Retention jobs:** an hourly batched purge (pg-boss cron, singleton), a recompute job when policies change, and safety while ingest runs concurrently.
- [x] **M6-03 [S · medium] Bulk delete:** delete by filter as a job with progress, and "disconnect and delete this integration's data".
- [x] **M6-04 [S · high] Account deletion:** every table, key, session and export file. *Done when:* a completeness test that lists tables from the schema finds zero rows left for the user. *(Done for the database: the completeness test discovers the tables and fails if one is unseeded or its key to `user` does not cascade. The export files part is `AccountDeletionSteps`, which M6-05 fills: see below.)*
- [x] **M6-05 [S · medium] Export:** a job producing NDJSON.gz + `manifest.json`, an expiring download link, and a cleanup job. **Also owes M6-04's export-file half:** register an `AccountDeletionStep` (`apps/api/src/modules/account/account.steps.ts`) that removes the user's export files, idempotent (a missing file is fine) and run before the deletion transaction, with an int test that creates an export, deletes the account and finds no file left. The `exports` table gets a row in the completeness test's seeding (`account.int.spec.ts`), which fails until it does.
- [ ] **M6-06 [S · high] Tests:** retention with a fake clock, deletion completeness, and an export round trip (every line validates against `contracts`).
- [ ] **M6-07 [H · low] Docs:** the export format and a data-lifecycle page.
- [ ] **M6-R [O · high] Milestone review.**

### M7: Hardening and v1.0

- [ ] **M7-01 [S · high] The full 8-step demo as one Firefox e2e test in CI** (`firefox-mv3` build, web-ext + Selenium), plus the Edge smoke passing. This is the v1 definition of done.
- [ ] **M7-02 [S · high] Route-table-generated suite:** every route checked for unauthenticated, wrong-key-type and cross-tenant access.
- [ ] **M7-03 [S · medium] Hardening:** rate limits (login, pairing, ingest per key), helmet security headers, and CSRF checks on mutations (every session-cookie POST/PATCH/DELETE, including `DELETE /v1/events`).
- [ ] **M7-04 [O · xhigh] Security pass:** `/security-review`, fixes, and a short threat model in `docs/`.
- [ ] **M7-05 [H · medium] Production packaging:** extension zips for AMO (first, with its source-code bundle) and then Edge Add-ons, a multi-stage Dockerfile, a compose prod profile, a Caddy example, and dependency audit and license check.
- [ ] **M7-06 [H · low] Docs:** README quickstart and `self-hosting.md` (TLS, backups, upgrades), with `rule-format.md` and `api.md` finalized.
- [ ] **M7-07 [H · low] Release prep:** CHANGELOG and version bump. Tagging `v1.0.0` needs the user's approval.
- [ ] **M7-R [O · xhigh] Final review.**

### v1.1 and later (explicitly out of v1)

Webhook `forward` action (HMAC-signed, retries, SSRF guard), a GitHub integration (webhooks for commits and PRs, which proves a second real source), content-script interactions for one site, Postgres RLS, user-defined event types with JSON Schema, Chrome support (the third browser: a Chrome smoke e2e in CI and a Chrome Web Store listing, which has a one-time developer fee), monthly partitioning if volume needs it.

---

## 11. Risks and how they are handled

| Risk | Mitigation |
| --- | --- |
| MV3 background gets killed (Edge service worker, Firefox event page), so in-memory state is lost | Persist everything to IndexedDB at capture. Use alarms, not timers. Spike A (Chromium) and Spike C (Firefox) prove this before anything is built on it. |
| Firefox and Edge APIs differ (idle/lock states, background lifecycle, permission prompts) | One `browser.*` codebase via WXT; Spike C records the differences; unit tests run for both builds; the full e2e runs on Firefox and an Edge smoke e2e runs in CI. When the two differ, the Firefox behaviour is the reference. |
| Time-on-site inflates from missed "end" events | Send closed `focus_segment` intervals. Idle, lock and blur close the open segment. Cap any single segment at 30 minutes. |
| Rules change while events sit in the queue | The server always re-applies current collect rules, and the stricter outcome wins. `meta.ruleSetVersion` is recorded for debugging. |
| Rule bugs widen collection | Deny by default, fail closed, property tests on the engine, and the dry-run preview before saving. |
| The `tabs` permission shows a "read browsing history" warning | Unavoidable for this product. Explain it on the onboarding screen. Distribute v1 through Firefox Add-ons first, then Edge Add-ons (both free), or unpacked; the Chrome Web Store follows in v1.1. |
| Client clock skew | Store both `occurredAt` and `receivedAt`. Clamp future timestamps and flag them. |
| Scope creep from the big vision | Anything not on the M0–M7 list goes to v1.1 or later. |

---

## 12. How to work through this with Claude Code

### Model routing

| Model | Owns | Examples |
| --- | --- | --- |
| **Haiku 5.5** `[H]` | Setup, config, docs, simple and mechanical tasks | Scaffolds, CI, compose, Dockerfile, README and docs, UI copy and polish |
| **Sonnet 5.5** `[S]` | **All Claude implementation** (any effort, `xhigh` for the hardest) and **all tests** | CRUD modules, UI pages, the extension popup, every test suite, and the tests for high-effort and `{deepseek}` tasks, written first (Sonnet low/medium) |
| **Opus 5.5** `[O]` | **Reviews only** (since 2026-10-16), and helping when Sonnet is stuck, at the user's say-so | Every `Mx-R` review and `/security-review` |

**Escalation rule:** if a Haiku or Sonnet task hits a design question, an unexpected failure it can't explain, or anything that touches auth, tenant scoping or the privacy invariants, stop and tell the user, who lets Opus join if needed. Don't guess.

### Automatic routing (no manual model or effort switching)

You run one command. The session you type in is only a **coordinator**: it reads the task tag and launches a subagent with that tag's model and effort. That's how a Haiku task, a Sonnet task and an Opus task run back to back without you touching `/model` or `/effort`.

| Command | What it does |
| --- | --- |
| `/task M1-05` | Runs one task end to end with the routing below |
| `/milestone M1` | Refines the milestone's tasks (Opus · high), runs every unchecked task in order, then the `Mx-R` review |
| `/milestone M1 auto-merge` | Same, but squash-merges each PR once CI is green, without asking each time |

**Coordinator setup (once):** set the session to **Sonnet · medium** (`/model sonnet`, `/effort medium`) and leave it there. The coordinator does no heavy thinking itself; it only routes, runs checks and handles git. All the real work happens in subagents at their tagged level.

Commands live in `.claude/skills/`: `task` and `milestone`. The session works inline; only `Mx-R` launches the `reviewer` subagent (`.claude/agents/`).

### Per-task loop (what `/task` does)

| Tag | Steps |
| --- | --- |
| `[H · e]` | Do the task inline on Haiku at effort *e*. Tests, if any, are part of it. |
| `[S · e]` | Do the task inline on Sonnet at effort *e*: tests and code. |
| `[S · high]` / `[S · xhigh]` / security-touching | Write the failing tests from "done when" first, then implement until they pass. Never weaken the tests. |
| `Mx-R` | `reviewer` on Opus at the tagged effort reviews the whole milestone diff. |

Around every task, the coordinator:

1. Creates branch `mx-nn-short-name` from an up-to-date `main`.
2. After the subagents finish, runs `pnpm lint && pnpm typecheck && pnpm test` itself. It never trusts "done" without seeing green output.
3. Commits, pushes, opens a PR and waits for CI.
4. Ticks the task's box in this file on the branch, then merges only when you approve (or in `auto-merge` mode).

**Escalation:** if the checks still fail after two fix attempts, or you hit a design question or anything touching auth, tenant scoping or the privacy invariants, stop and tell the user with the evidence; Opus joins to fix it only when the user says so.

Record every reversed decision as an ADR in `docs/adr/`.

---

## 13. Open items for the user

- ~~Git repo~~ → resolved: `github.com/Mohaned178/personal-api` (empty when this plan was written).
- **Project name and extension name** for the AMO and Edge Add-ons listings (can wait until M7; the Chrome Web Store listing reuses them in v1.1).
