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
| Browsers | **Chromium** (Chrome, Edge, Brave, Arc) with one MV3 build. WXT keeps a later Firefox build cheap. |
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
| Extension | **WXT** (Vite-based, MV3) + TypeScript; IndexedDB queue via `idb` | Best DX for MV3: hot reload, manifest generation, and a cross-browser path later. |
| Dashboard | **Vite + React 19 + TanStack Router/Query + shadcn/ui + Tailwind v4** | A logged-in SPA needs no SSR. The API serves it as static files, so it's same-origin with simple cookies and no CORS. |
| Lint/format | **Biome** | One fast tool for lint and format. |
| Tests | **Vitest** (with SWC for Nest decorators), **supertest** against the Nest app, **Testcontainers** (Postgres), **fast-check** (rule properties), **Playwright** (loads the unpacked extension for e2e) | The full demo runs as an automated e2e test in CI. |
| Deploy | **docker compose**: `postgres`, `api`, `worker` (same image, different command). Optional **Caddy** for TLS on a VPS. | One documented command. |

Pin exact versions when scaffolding in M0, using releases at least 14 days old. The dev Postgres runs on **port 5433** so it never touches a Postgres already on 5432.

---

## 3. Architecture

```text
┌──────────── Chrome extension (MV3, WXT) ─────────────┐        ┌──── other sources (v1: any HTTP client) ───┐
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
│ GET /v1/ingest/config  (rules + enabled types, ETag) · POST /v1/ingest/heartbeat                  │
│ Platform API (session cookie) · Read API (session or pa_read_ key) · /v1/me/:slug saved queries  │
│ Serves the dashboard SPA as static files                                                          │
└──────────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                           ▼
             PostgreSQL 18 — app tables + pgboss schema  ◄──  worker: retention · bulk delete · export
```

### Key principles

1. **Privacy filtering happens before data leaves the browser.** Collect-stage rules run in the extension, so a denied site never generates a request. The server re-applies them anyway, because the extension is untrusted and rules can change while events sit in the queue.
2. **One rule engine runs on both sides.** `packages/rules` is pure TypeScript with no Node or DOM APIs, so the extension, server and "test rule" preview all give identical answers.
3. **Delivery is at-least-once, storage is effectively-once.** The extension assigns each event a UUIDv7 when it's captured. A unique constraint on `(user_id, integration_id, client_event_id)` turns retries into `duplicate` results instead of new rows. The system doesn't claim exactly-once.
4. **Fail closed.** If there are no rules, invalid rules, or an engine error, nothing is collected or stored, and an error is surfaced. A misconfiguration must never silently widen collection.
5. **Dropped events are never stored.** Only counters are kept, per rule, per day, with no payload. Even "what we didn't keep" doesn't leak.

---

## 4. Data model (v1)

```text
users, sessions, accounts, verification — Better Auth
integrations   id, user_id, kind ('chrome-extension' | 'http'), name, default_policy ('deny'|'allow'),
               status ('active'|'revoked'), last_seen_at, last_heartbeat jsonb (queue depth, version)
api_keys       id, user_id, kind ('ingest'|'read'), integration_id?, prefix, hash, scopes jsonb,
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
endpoints      id, user_id, slug, definition jsonb (saved query), enabled
exports        id, user_id, status, filter jsonb, file_path, expires_at
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
| `browser.page_visited` | domain, path, transition, tabRef | Navigation committed in a tab. `tabRef` is a per-session random id, not the Chrome tab id. |
| `browser.focus_segment` | domain, path, startedAt, endedAt, durationMs | A **closed interval** of real attention. It ends on tab switch, window blur, idle (60 s) or lock. Time-on-site is the sum of these intervals, so lost events can't cause runaway durations. |
| `browser.tab_opened` / `browser.tab_closed` | tabRef, domain? | |
| `browser.session_started` / `browser.session_ended` | reason (startup/idle/lock/shutdown) | A session ends after 30 minutes idle. |

Page titles, full URLs, form contents, keystrokes and incognito activity are **never** collected in v1. Incognito also requires the user to opt in at the Chrome level, and the extension ignores incognito tabs even then.

---

## 5. Rule format

```json
{
  "name": "Track GitHub, but not settings pages",
  "enabled": true,
  "priority": 10,
  "stage": "collect",
  "when": {
    "source": ["chrome-extension"],
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

Errors use RFC 9457 `application/problem+json`. Lists use keyset cursors on `(occurred_at, id)`. OpenAPI is served at `/docs`.

| Auth | Endpoint | Purpose |
| --- | --- | --- |
| none | `GET /healthz`, `GET /readyz` | Liveness, and DB + queue readiness |
| pairing code | `POST /v1/pair` | Exchange a one-time code for an ingest key |
| ingest key | `POST /v1/ingest/events` | Batch of up to 100 events and 256 KB. Returns per-item results. |
| ingest key | `GET /v1/ingest/config` | Collect rules, enabled types and rule-set version, with ETag |
| ingest key | `POST /v1/ingest/heartbeat` | Queue depth, oldest queued age, version |
| session | `/v1/integrations` (CRUD, pairing code, revoke) | Connect and disconnect sources |
| session | `/v1/rules` (CRUD), `POST /v1/rules/test` | Manage rules and dry-run them against a sample event |
| session | `DELETE /v1/events` (ids or filter), `/v1/exports`, `/v1/retention` | Data management |
| session | `/v1/keys`, `/v1/endpoints` | Read keys and saved queries |
| session | `GET /v1/diagnostics` | Ingestion log, integration last-seen, queue backlog, job failures |
| session or read key | `GET /v1/events?source=&type=&from=&to=&domain=&cursor=` | Raw events |
| session or read key | `GET /v1/activity/daily`, `GET /v1/activity/domains` | Aggregates computed with SQL at query time (no materialized tables needed at this volume) |
| read key scoped to it | `GET /v1/me/:slug` | A user-defined saved query |

**Saved query definition:** source and type filters, a relative time window (`today`, `this_week`, `last_n_days`), the same condition language as rules, a field allowlist for projection, and an optional aggregate (`count_by_day`, `count_by_domain`, `duration_by_domain`). Hard limits: 1,000 rows and a 2-second `statement_timeout`. An aggregate-only endpoint can never return raw events. That covers "share my browsing stats without individual visits".

---

## 7. Extension behavior

- **Permissions:** `tabs`, `idle`, `storage`, `alarms`. The API origin is requested at runtime from `optional_host_permissions` when the user enters the server URL. There are no content scripts and no `<all_urls>`.
- **Connect flow:** in the dashboard, choose "Add Chrome extension" to get a 10-minute pairing code. In the popup, enter the server URL and code. The extension requests the origin permission, calls `POST /v1/pair`, stores the key, and fetches the config.
- **Queue:** events are persisted to IndexedDB at capture time, because the MV3 service worker can be killed at any moment. A flush runs on an alarm and on new events, in batches of 100, with exponential backoff and jitter. The queue is capped at 50k events or 14 days. If it overflows, the oldest events are dropped **and the drop count is shown and reported in the heartbeat**, so nothing is lost silently.
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
  apps/web/            React dashboard (built into apps/api/public at release)
  apps/extension/      WXT MV3 extension
  apps/e2e/            Playwright e2e (loads the unpacked extension) + local fixture site
  packages/contracts/  Zod: envelope, event types, API DTOs, rule + saved-query schemas
  packages/rules/      Pure rule engine + saved-query validator (no Node/DOM deps)
  packages/tsconfig/   Shared TS config
  docs/                PLAN.md, self-hosting.md, event-types.md, rule-format.md, api.md, adr/
  docker-compose.yml   postgres (5433), api, worker
  CLAUDE.md
```

---

## 10. Milestones and tasks

Each milestone ends with something demoable, green CI and a short demo note in the PR.

**Legend:** each tag is `[model · effort]`. You never pick these yourself: `/task` and `/milestone` read the tag and launch the right model at the right effort (see §12).

- **Model:** `H` Haiku: setup, config, docs, simple tasks. `S` Sonnet: implementation and **all tests**. `O` Opus: complex or security-critical implementation, plus **every review**.
- **Effort:** `low` is mechanical work with an obvious answer. `medium` is normal feature work. `high` covers tricky edge cases, concurrency, security-adjacent work or fiddly tooling. `xhigh` is reserved for core correctness and security (keys, tenant scoping, the ingest transaction, the offline queue, the rule engine, the query compiler, privacy-critical reviews). `max` isn't used by default. It's the retry level when an `xhigh` task fails twice.

- On an `[O]` task, **Sonnet writes the tests first** from the "done when" criteria, then Opus implements until they pass. The tests stay independent of the code they check.
- Tasks are numbered `Mx-NN`, with one branch per task (`mx-nn-short-name`).
- M0 to M3 tasks are concrete. M4 to M7 have firm scope, but get refined at the start of each milestone.

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
- [ ] **M0-R [O · high] Milestone review** (`/code-review` + `/security-review`). Auth, cookies and log redaction land in M0.

### M1: Ingestion API

- [ ] **M1-01 [O · high] Contracts:** the envelope schema, an event-type registry (`type@version` → Zod schema) and the v1 browser types in `packages/contracts`. *Done when:* unknown types and versions are rejected with clear error codes, and the types are exported for both the API and the extension.
- [ ] **M1-02 [S · medium] Schema:** `integrations`, `api_keys`, `events` (unique dedupe key + indexes from §4) and `ingestion_log` migrations.
- [ ] **M1-03 [O · xhigh] API keys and tenant scoping:** key generation (prefix + 32 random bytes), SHA-256 at rest, constant-time lookup, `IngestKeyGuard`, an `AuthContext` that carries `userId` + `integrationId`, a tenant-scoped repository helper that won't run a query without `userId`, and throttled `last_used_at`. *Done when:* revoked or unknown keys get 401 and no repository method can be called without a user scope.
- [ ] **M1-04 [S · medium] Integrations module:** session CRUD, creating an `http` integration with a key shown once, and revoke.
- [ ] **M1-05 [O · xhigh] `POST /v1/ingest/events`:** batch limits (100 events / 256 KB), envelope and payload validation, future-timestamp clamping, one transaction with `INSERT … ON CONFLICT DO NOTHING`, per-item results, and the hourly `ingestion_log` upsert. *Done when:* the M1-07 tests pass.
- [ ] **M1-06 [S · low] Heartbeat:** `POST /v1/ingest/heartbeat`, plus `last_seen_at` and `last_heartbeat` on the integration.
- [ ] **M1-07 [S · high] Test suite:** the same batch sent 3 times gives 1 row; concurrent duplicate posts give 1 row; malformed, oversized and partly-invalid batches; revoked keys; cross-tenant isolation (a two-user fixture reused by every later milestone).
- [ ] **M1-08 [H · low] Docs:** `docs/event-types.md` and `curl` examples in `docs/api.md`.
- [ ] **M1-R [O · high] Milestone review** (`/code-review` + `/security-review`).

### M2: Extension capture and delivery

- [ ] **M2-01 [S · high] Pairing (API):** a `pairing_codes` table, `POST /v1/integrations/:id/pairing-code` (session) and `POST /v1/pair` (single use, 10-minute expiry, rate limited). *Done when:* tests cover expired, reused and brute-force-throttled codes.
- [ ] **M2-02 [S · medium] Connect UI (extension):** server URL input, `chrome.permissions.request` for that origin, pairing, key stored in `chrome.storage.local`, and a disconnect button.
- [ ] **M2-03 [S · high] URL sanitizer:** keep domain + path, strip query and fragment, normalize IDN and case, and ignore non-http(s) schemes (`chrome://`, `file://`, `about:`). *Done when:* property tests show the output never contains `?` or `#`.
- [ ] **M2-04 [O · high] Capture engine:** listeners → `page_visited`, `tab_opened/closed`, a `focus_segment` state machine, session start and end, incognito ignored, state persisted following the Spike A ADR. *Done when:* unit tests with mocked chrome APIs and fake timers pass, covering the idle, lock and blur cases.
- [ ] **M2-05 [O · xhigh] Persistent queue and sync:** IndexedDB store, alarm-driven batch flush, backoff + jitter, per-item result handling, the 50k / 14-day cap with a reported drop counter, and 401 → disconnected. *Done when:* tests cover network failure, partial batch failure and a service-worker restart mid-flush with no loss and no duplicates.
- [ ] **M2-06 [S · medium] Popup v1 and heartbeat:** connection state, pause/resume, queue depth, last sync, dropped count, and a heartbeat on an alarm.
- [ ] **M2-07 [S · low] Temporary allow list** in extension storage (replaced in M4).
- [ ] **M2-08 [S · high] e2e:** pair → visit fixture → events in the DB; go offline → reconnect → nothing lost or duplicated.
- [ ] **M2-R [O · high] Milestone review.**

### M3: Dashboard v0

- [ ] **M3-01 [H · medium] `apps/web` scaffold:** Vite, React 19, TanStack Router + Query, Tailwind v4 and shadcn/ui. The API serves the build statically, with a dev proxy to the API.
- [ ] **M3-02 [S · medium] Auth pages:** first-run setup, signup, login, logout, and route guards.
- [ ] **M3-03 [S · medium] Integrations page:** list, add extension (shows the pairing code with a countdown), add HTTP integration (key shown once), and revoke with confirmation.
- [ ] **M3-04 [S · medium] Platform events API (session):** list with filters + keyset cursor, get one, delete by ids, including cross-tenant tests.
- [ ] **M3-05 [S · medium] Events browser UI:** virtualized table, filters (source, type, time range, domain), a detail drawer (JSON, origin, integration) and multi-select delete.
- [ ] **M3-06 [S · medium] Diagnostics API and Health page:** last seen per integration, queue depth from heartbeats, and accepted/duplicate/dropped/rejected charts.
- [ ] **M3-07 [H · low] UI polish:** empty, loading and error states, and copy.
- [ ] **M3-R [O · medium] Milestone review.**

### M4: Rules

- [ ] **M4-01 [O · high] Rule format:** the Zod schema in `contracts`, a per-type field registry (which fields conditions may use), and a draft of `docs/rule-format.md`.
- [ ] **M4-02 [O · xhigh] Engine (`packages/rules`):** `evaluate(event, rules, policy) → {decision, event, trace}` with the ops, actions, priority and drop-beats-allow semantics from §5. Pure, with no I/O.
- [ ] **M4-03 [S · high] Engine tests:** table tests per op and action, plus fast-check properties (drop dominance, determinism, idempotent transforms, invalid input → fail closed).
- [ ] **M4-04 [S · medium] Rules API:** CRUD, rule-set versioning, `rule_history` snapshots, validation on save, and `POST /v1/rules/test`.
- [ ] **M4-05 [O · xhigh] Server enforcement:** per-user rule-set cache invalidated by version, collect then process stages at ingest, stored traces, per-rule drop counters, and engine errors → `rejected(rule_error)`.
- [ ] **M4-06 [S · high] Extension rule sync:** `GET /v1/ingest/config` with ETag, alarm-based sync, fail closed when rules are missing or invalid, removal of the M2-07 list, and the current-tab verdict in the popup.
- [ ] **M4-07 [S · medium] Rules UI:** list with priority ordering, form builder, JSON toggle with inline errors, test against a sample event, and drop counts.
- [ ] **M4-08 [S · medium] Explainability:** the "why is this here" view on events, and onboarding starter templates.
- [ ] **M4-09 [S · high] e2e:** demo steps 3 and 7 (add a rule → collected; change the rule → later events behave differently).
- [ ] **M4-R [O · xhigh] Milestone review** (`/code-review` + `/security-review`).

### M5: Query API and user endpoints

- [ ] **M5-01 [S · high] Read keys:** scopes (`events:read`, `activity:read`, `endpoint:<id>`), optional source/type restriction, `ReadKeyGuard`, and a keys UI.
- [ ] **M5-02 [S · medium] `GET /v1/events`** for a session or read key, with scope filtering applied.
- [ ] **M5-03 [S · medium] Aggregates:** `/v1/activity/daily` and `/v1/activity/domains` (time from focus segments), plus a user time zone setting.
- [ ] **M5-04 [O · xhigh] Saved-query compiler:** definition schema → parameterized Drizzle query, a field-allowlist projection, aggregate modes, row limits, `statement_timeout`, and aggregate-only enforcement.
- [ ] **M5-05 [S · medium] Endpoints:** CRUD, `GET /v1/me/:slug`, and a UI with live preview + a copyable `curl`.
- [ ] **M5-06 [S · high] Tests:** injection attempts through field names and values, limit and timeout, scope escalation (endpoint A's key calling B or `/events`), and cross-tenant.
- [ ] **M5-07 [H · low] OpenAPI** at `/docs`, and `docs/api.md`.
- [ ] **M5-R [O · xhigh] Milestone review** (`/code-review` + `/security-review`).

### M6: Data lifecycle

- [ ] **M6-01 [S · medium] Retention policies:** table, API and UI. `expires_at` is set at insert, with precedence rule `set_retention` > type policy > source policy > default 90 days.
- [ ] **M6-02 [O · high] Retention jobs:** an hourly batched purge (pg-boss cron, singleton), a recompute job when policies change, and safety while ingest runs concurrently.
- [ ] **M6-03 [S · medium] Bulk delete:** delete by filter as a job with progress, and "disconnect and delete this integration's data".
- [ ] **M6-04 [O · high] Account deletion:** every table, key, session and export file. *Done when:* a completeness test that lists tables from the schema finds zero rows left for the user.
- [ ] **M6-05 [S · medium] Export:** a job producing NDJSON.gz + `manifest.json`, an expiring download link, and a cleanup job.
- [ ] **M6-06 [S · high] Tests:** retention with a fake clock, deletion completeness, and an export round trip (every line validates against `contracts`).
- [ ] **M6-07 [H · low] Docs:** the export format and a data-lifecycle page.
- [ ] **M6-R [O · high] Milestone review.**

### M7: Hardening and v1.0

- [ ] **M7-01 [S · high] The full 8-step demo as one Playwright e2e test in CI.** This is the v1 definition of done.
- [ ] **M7-02 [S · high] Route-table-generated suite:** every route checked for unauthenticated, wrong-key-type and cross-tenant access.
- [ ] **M7-03 [S · medium] Hardening:** rate limits (login, pairing, ingest per key), helmet security headers, and CSRF checks on mutations.
- [ ] **M7-04 [O · xhigh] Security pass:** `/security-review`, fixes, and a short threat model in `docs/`.
- [ ] **M7-05 [H · medium] Production packaging:** a multi-stage Dockerfile, a compose prod profile, a Caddy example, and dependency audit and license check.
- [ ] **M7-06 [H · low] Docs:** README quickstart and `self-hosting.md` (TLS, backups, upgrades), with `rule-format.md` and `api.md` finalized.
- [ ] **M7-07 [H · low] Release prep:** CHANGELOG and version bump. Tagging `v1.0.0` needs the user's approval.
- [ ] **M7-R [O · xhigh] Final review.**

### v1.1 and later (explicitly out of v1)

Webhook `forward` action (HMAC-signed, retries, SSRF guard), a GitHub integration (webhooks for commits and PRs, which proves a second real source), content-script interactions for one site, Postgres RLS, user-defined event types with JSON Schema, Firefox build, monthly partitioning if volume needs it.

---

## 11. Risks and how they are handled

| Risk | Mitigation |
| --- | --- |
| MV3 service worker gets killed, so in-memory state is lost | Persist everything to IndexedDB at capture. Use alarms, not timers. Spike A proves this before anything is built on it. |
| Time-on-site inflates from missed "end" events | Send closed `focus_segment` intervals. Idle, lock and blur close the open segment. Cap any single segment at 30 minutes. |
| Rules change while events sit in the queue | The server always re-applies current collect rules, and the stricter outcome wins. `meta.ruleSetVersion` is recorded for debugging. |
| Rule bugs widen collection | Deny by default, fail closed, property tests on the engine, and the dry-run preview before saving. |
| The `tabs` permission shows a "read browsing history" warning | Unavoidable for this product. Explain it on the onboarding screen. Distribute v1 as unpacked or as a private Web Store listing. |
| Client clock skew | Store both `occurredAt` and `receivedAt`. Clamp future timestamps and flag them. |
| Scope creep from the big vision | Anything not on the M0–M7 list goes to v1.1 or later. |

---

## 12. How to work through this with Claude Code

### Model routing

| Model | Owns | Examples |
| --- | --- | --- |
| **Haiku 5.5** `[H]` | Setup, config, docs, simple and mechanical tasks | Scaffolds, CI, compose, Dockerfile, README and docs, UI copy and polish |
| **Sonnet 5.5** `[S]` | Most implementation and **all tests** | CRUD modules, UI pages, the extension popup, every test suite, and the tests for `[O]` tasks, written first |
| **Opus 5.5** `[O]` | Complex or security-critical implementation, and **all reviews** | Envelope/contracts, API keys and tenant scoping, the ingest transaction, the capture engine and queue, the rule engine, the saved-query compiler, retention/deletion, every `Mx-R` review and `/security-review` |

**Escalation rule:** if a Haiku or Sonnet task hits a design question, an unexpected failure it can't explain, or anything that touches auth, tenant scoping or the privacy invariants, stop and hand it to Opus. Don't guess.

### Automatic routing (no manual model or effort switching)

You run one command. The session you type in is only a **coordinator**: it reads the task tag and launches a subagent with that tag's model and effort. That's how a Haiku task, a Sonnet task and an Opus task run back to back without you touching `/model` or `/effort`.

| Command | What it does |
| --- | --- |
| `/task M1-05` | Runs one task end to end with the routing below |
| `/milestone M1` | Refines the milestone's tasks (Opus · high), runs every unchecked task in order, then the `Mx-R` review |
| `/milestone M1 auto-merge` | Same, but squash-merges each PR once CI is green and the review found no blockers, without asking each time |

**Coordinator setup (once):** set the session to **Sonnet · medium** (`/model sonnet`, `/effort medium`) and leave it there. The coordinator does no heavy thinking itself; it only routes, runs checks and handles git. All the real work happens in subagents at their tagged level.

The subagents live in `.claude/agents/`: `builder`, `test-writer` and `reviewer`. The commands live in `.claude/skills/`: `task` and `milestone`.

### Per-task loop (what `/task` does)

| Tag | Steps |
| --- | --- |
| `[H · e]` | `builder` on Haiku at effort *e* does the task. Tests, if any, are part of it. |
| `[S · e]` | `builder` on Sonnet at effort *e* writes the tests and the code. |
| `[O · e]` | 1. `test-writer` on Sonnet · high writes failing tests from "done when". 2. `builder` on Opus at effort *e* implements until they pass. It must not weaken the tests. 3. `reviewer` on Opus · high reviews the PR. |
| `Mx-R` | `reviewer` on Opus at the tagged effort reviews the whole milestone diff. |

Around every task, the coordinator:

1. Creates branch `mx-nn-short-name` from an up-to-date `main`.
2. After the subagents finish, runs `pnpm lint && pnpm typecheck && pnpm test` itself. It never trusts "done" without seeing green output.
3. Commits, pushes, opens a PR and waits for CI.
4. Ticks the task's box in this file on the branch, then merges only when you approve (or in `auto-merge` mode).

**Escalation (automatic):** if a builder fails the checks twice, the coordinator retries once more one level up (Haiku → Sonnet, Sonnet → Opus, Opus `xhigh` → `max`). If that fails too, or a subagent reports a design question or anything touching auth, tenant scoping or the privacy invariants, the coordinator stops and asks you.

Record every reversed decision as an ADR in `docs/adr/`.

---

## 13. Open items for the user

- ~~Git repo~~ → resolved: `github.com/Mohaned178/personal-api` (empty when this plan was written).
- **Project name and extension name** for the Web Store listing (can wait until M7).
