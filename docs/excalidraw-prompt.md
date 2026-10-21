# Personal API: Excalidraw generation spec

How to use: give this whole file to an AI and ask for a single `.excalidraw` JSON file (or Mermaid per diagram). If the model truncates, feed it one `## DIAGRAM` block at a time, always together with the "Global rules" and "Legend" sections.

Tagline: **Your Data. Your Endpoints. Your Rules.**
Status date: 2026-10-18. Milestones M0 to M4 are done (M4 review fixes in progress). M5 to M7 are open.

---

## Global rules for the AI

- Output: valid Excalidraw JSON (`type: "excalidraw"`, `version: 2`, an `elements` array). Rectangles, diamonds, ellipses, arrows with bound `startBinding`/`endBinding`, and text. Group each frame's elements. Use `roughness: 1` (hand-drawn), `fontFamily: 1`, and `fontSize` 16 for node text, 20 for frame titles, 36 for the board title.
- One board. Place the 10 diagrams as large labelled frames in a grid, 2 frames per row, with 200 px gaps. The board title is "Personal API: Architecture Overview", centered at the top. A legend goes at the top right.
- Every arrow carries a short label (protocol, route or action). No unlabelled arrows. No crossing arrows where a re-route avoids it. Align nodes to a 20 px grid. Never overlap text.
- Text must fit inside its shape (wrap manually with `\n`, 28 characters per line at most).
- Do not invent components. Use only what is written here.

## Legend (color code)

| Meaning | Fill | Stroke |
| --- | --- | --- |
| Browser extension and clients | `#a5d8ff` | `#1971c2` |
| API and server | `#b2f2bb` | `#2f9e44` |
| Database and storage | `#d0bfff` | `#6741d9` |
| Rules and engine | `#ffd8a8` | `#e8590c` |
| Privacy and security | `#ffc9c9` | `#e03131` |
| Tooling, docs, process | `#e9ecef` | `#495057` |
| Done (status board) | `#b2f2bb` | `#2f9e44` |
| Open (status board) | `#f1f3f5` | `#868e96` |
| In progress (status board) | `#ffec99` | `#f08c00` |

Shapes: rectangle = component or service; rounded rectangle = process step; cylinder or ellipse = data store; diamond = decision; dashed arrow = optional or async; solid arrow = synchronous call or data flow.

---

## What the project is

Personal API is a self-hosted, multi-account personal data platform. A browser extension (Firefox first, then Edge, Chrome after v1) and later other sources send events to the user's own server. User-defined rules decide what is collected and kept. Users then query their data through built-in endpoints and their own saved-query endpoints. All data stays on the user's server.

---

## DIAGRAM 1: System architecture (center of the board, left to right)

Nodes (use the colors from the legend):
1. **Browser Extension** (blue, large container). Inside, in this order, with arrows between them: `tabs/idle listeners` → `normalize` → `sanitize URL (domain + path only)` → `collect rules (shared engine, cached, fail-closed)` → `IndexedDB queue` → `batch flush (browser.alarms + backoff)`. A small `Popup` box hangs below it: connection, pause/resume, queue depth, last sync, dropped count, current-tab verdict.
2. **Other sources** (blue): `curl / scripts / future GitHub integration`.
3. **API (NestJS)** (green, large container) with these inner boxes:
   - `POST /v1/ingest/events`
   - `GET /v1/ingest/config`
   - `POST /v1/ingest/heartbeat`
   - `POST /v1/pair`
   - `Platform API (session cookie)`
   - `Read API (session or pa_read_ key)`
   - `/v1/me/:slug saved queries`
   - `Serves dashboard SPA + OpenAPI /docs`
4. **Dashboard (React SPA)** (blue): setup, login, integrations, rules, events, diagnostics, keys, endpoints, exports, retention.
5. **PostgreSQL 18** (purple cylinder): `app tables + pgboss schema`.
6. **Worker (pg-boss)** (green): `retention purge · bulk delete · export`.

Arrows:
- Extension → API: `Bearer pa_ing_… · POST /v1/ingest/events (≤100 events, ≤256 KB)`
- Extension → API: `GET /v1/ingest/config (ETag) · POST /heartbeat`
- Other sources → API: `Bearer pa_ing_… (http integration)`
- Dashboard → API: `session cookie`
- API → PostgreSQL: `Drizzle · 1 transaction per batch`
- Worker ↔ PostgreSQL: `pg-boss jobs`
- External consumers (small box `Scripts / apps`, blue) → API: `Bearer pa_read_… · GET /v1/me/:slug`

---

## DIAGRAM 2: Ingest pipeline (top to bottom flowchart)

Steps:
1. `Request: Bearer pa_ing_` → `Auth: SHA-256 lookup, integration from key (never from body)`
2. → `Validate batch (≤100) and envelope (Zod)` → `Per-type payload validation`
3. → `Collect rules again (defense in depth)` → diamond `Decision`
4. Diamond branches:
   - `drop` → `Per-rule daily counter only (never store payload)` (red)
   - `rule error` → `rejected(rule_error)`
   - `allow` → `Process rules: tag, set_retention` (orange)
5. → `ONE transaction: INSERT … ON CONFLICT DO NOTHING + ingestion_log upsert` (purple)
6. → `Per-item result: accepted | duplicate | dropped(rule) | rejected(error)`

Side notes (yellow sticky notes):
- `occurredAt > 5 min in the future → clamped to receivedAt, original saved in client_occurred_at`
- `occurredAt older than the window (90 days) → ingest.occurred_at_too_old`
- `Body > 256 KB → 413 http.payload_too_large`
- `Empty or > 100 events or unknown keys → 400 ingest.batch_invalid`
- `Exception: if meta.ruleSetVersion equals the server's current version (≥1) and an allow rule reads a field that a collect coarsen/redact rewrites, the server skips re-asking the default policy. A drop rule still wins.`

---

## DIAGRAM 3: Pairing and connect flow (sequence diagram, 4 lifelines)

Lifelines: `User`, `Dashboard`, `Extension popup`, `API`.
1. User → Dashboard: `Add browser extension`
2. Dashboard → API: `POST /v1/integrations/:id/pairing-code (session)`
3. API → Dashboard: `10-minute one-time code`
4. User → Extension popup: `enter server URL + code`
5. Extension popup → Browser (note): `permissions.request(API origin), inside the click handler`
6. Extension popup → API: `POST /v1/pair (rate limited, single use)`
7. API → Extension popup: `ingest key pa_ing_… (shown once)`
8. Extension popup → API: `GET /v1/ingest/config`
9. Note: `start capturing`

Failure notes: `expired / reused / throttled code → rejected`; `401 or revoked key → Disconnected state: stop capture, offer "clear local queue"`.

---

## DIAGRAM 4: Rule engine (two parts)

Part A, the rule JSON (orange card): `name`, `enabled`, `priority`, `stage (collect | process)`, `when { source[], type[] (glob), all[], any[], none[] }`, `then [ {action} ]`. Each condition is `{field, op, value}`.

Part B, evaluation flowchart:
`Sort rules by priority` → `Apply transforms in order` → diamond `Terminal action reached?`
- yes → `First terminal action decides` (tie at same priority: **drop beats allow**)
- no → `integration.default_policy decides (deny for a new extension)`
- any error → `FAIL CLOSED: nothing collected or stored` (red)

Lists (orange chips):
- Operators: `eq, neq, in, starts_with, ends_with, contains, domain_matches (exact or *.example.com), matches_glob, gt/lt, exists`. A red chip says: `NO regex · NO code execution`.
- Collect-stage actions (run on the extension and the server): `allow, drop (terminal), redact, coarsen, keep_query`.
- Process-stage actions (server only): `tag, set_retention`. A grey chip: `forward (webhook): v1.1`.

Trace box (green): `trace = { ruleSetVersion, matched: [{ruleId, actions}], decidedBy }`, stored on each event and shown as "why is this here" in the dashboard and as the current-tab verdict in the popup.

Packages: a box `packages/rules (pure TS, no Node/DOM/chrome)` with two arrows into `Extension` and `API`, labelled "identical results".

---

## DIAGRAM 5: Data model (ER diagram, 13 entities)

Entities and key fields:
- `users / sessions / accounts / verification`: Better Auth.
- `integrations`: id, user_id, kind (browser-extension | http), name, default_policy (deny | allow), status (active | revoked), last_seen_at, last_heartbeat
- `api_keys`: id, user_id, kind (ingest | read), integration_id?, prefix, hash (SHA-256), scopes, endpoint_id?, created_at, last_used_at, revoked_at
- `pairing_codes`: code_hash, user_id, integration_id, expires_at (10 min), used_at
- `rule_sets`: user_id, version (bumps on every change), updated_at
- `rules`: id, user_id, name, enabled, priority, stage, definition (jsonb)
- `rule_history`: rule_set_version, snapshot (jsonb)
- `events`: id (uuidv7), user_id, integration_id, client_event_id, type, type_version, occurred_at, client_occurred_at?, received_at, origin (collected | imported | derived), data (jsonb), tags[], trace (jsonb), expires_at. **UNIQUE (user_id, integration_id, client_event_id)**. Indexes: (user_id, occurred_at DESC, id), (user_id, type, occurred_at), (expires_at).
- `ingestion_log`: user_id, integration_id, bucket (hour), accepted, duplicate, dropped, rejected, by_reason (counts only, no payloads). UNIQUE (user_id, integration_id, bucket).
- `retention_policies`: user_id, match (source/type), days
- `endpoints`: id, user_id, slug, definition (jsonb saved query), enabled
- `exports`: id, user_id, status, filter, file_path, expires_at

Relations (label the cardinality): users 1-N integrations, rules, api_keys, events, endpoints, exports, retention_policies; integrations 1-N events, api_keys, pairing_codes; rule_sets 1-N rule_history; endpoints 1-N api_keys (read keys scoped to an endpoint). Every tenant table has `user_id → user(id) ON DELETE CASCADE`.

---

## DIAGRAM 6: Event envelope and event types

Envelope card: `id (UUIDv7 from the client)`, `type`, `typeVersion`, `occurredAt`, `data`, `meta { ruleSetVersion, client }`. Annotations: `the server sets integration_id from the key, never from the body` and `unknown keys are rejected (strict schemas)`.

Event type cards:
| Type | Data |
| --- | --- |
| `browser.page_visited` | domain, path, transition?, tabRef (random per-session id) |
| `browser.focus_segment` | domain, path, startedAt, endedAt, durationMs (a closed interval of attention, ≤ 30 min, ending on tab switch, blur, 60 s idle or lock) |
| `browser.tab_opened` / `browser.tab_closed` | tabRef, domain? |
| `browser.session_started` / `browser.session_ended` | reason (start: startup/resume; end: idle/lock/shutdown/recovered). A session ends after 30 min idle. |

Red "Never collected" box: `page titles · full URLs · form contents · keystrokes · passwords · incognito tabs`. Note: `query strings and #fragments stripped unless a keep_query rule matches`.

---

## DIAGRAM 7: Extension internals and lifecycle

- Permissions card: `tabs, idle, storage, alarms`, plus `optional_host_permissions` (the API origin is requested at runtime). `No content scripts · no <all_urls> · incognito not allowed`.
- Builds: `WXT → firefox-mv3 (event page, primary)` and `WXT → chrome-mv3 (Edge service worker)`. Use `browser.*`, never `chrome.*`.
- Lifecycle flow: `background can be killed at any time` → `state lives in IndexedDB / browser.storage` → `browser.alarms wake it` → `listeners registered at top level` → `queue flush`.
- Queue box: `cap 50k events or 14 days; on overflow drop the oldest AND report the drop count in the heartbeat`.
- Response handling table:
  - `401 / revoked key → Disconnected (stop capture, offer clear queue)`
  - `per-item 4xx → remove that item, log locally`
  - `5xx / network error → retry with exponential backoff + jitter`
- Focus segment state machine (small): `Idle → Active (visit) → Segment closed (tab switch / blur / 60 s idle / lock) → Idle`.

---

## DIAGRAM 8: Auth, keys and saved queries

Left, auth types (three lanes):
- `Dashboard session`: Better Auth email + password, HttpOnly + SameSite=Lax cookie, CSRF on mutations, login and pairing rate limits, `ALLOW_SIGNUP` (the first account can always sign up).
- `pa_ing_ ingest key`: can only ingest (and read config and send heartbeat).
- `pa_read_ read key`: read-only, within scopes `events:read`, `activity:read`, `endpoint:<id>`, with an optional source/type restriction.
- Common: `SHA-256 hash at rest · shown once · prefix for display · last_used_at · immediate revocation · unknown/malformed/revoked keys all return the same 401 auth.invalid_key (no oracle)`.

Right, saved queries:
`definition: source/type filters · relative window (today, this_week, last_n_days) · same condition language as rules · field allowlist (projection) · optional aggregate (count_by_day, count_by_domain, duration_by_domain)` → `compiled to a parameterized Drizzle query` → `limits: 1,000 rows, 2 s statement_timeout` → `GET /v1/me/:slug`. Red note: `aggregate-only endpoints can never return raw events`.

Route table (small): public `/healthz /readyz /v1/setup/status`; pairing code `/v1/pair`; ingest key `/v1/ingest/*`; session `/v1/integrations /v1/rules /v1/rules/test /v1/events (DELETE) /v1/exports /v1/retention /v1/keys /v1/endpoints /v1/diagnostics`; session or read key `GET /v1/events /v1/activity/daily /v1/activity/domains`; read key scoped to it `GET /v1/me/:slug`.

---

## DIAGRAM 9: Privacy and security invariants (all red)

Eight numbered boxes:
1. Deny by default, fail closed. Missing, invalid or throwing rules mean nothing is collected or stored.
2. Dropped events are never stored (counters only).
3. The extension keeps domain + path only. Query and fragment are stripped unless `keep_query` matches. No titles, form contents, keystrokes or incognito.
4. Tenant scoping: every query goes through scoped repository helpers using `userId` from AuthContext, never from the request body. Every new route gets a cross-tenant test.
5. Keys are SHA-256 hashed and shown once. Ingest keys only ingest. Read keys only read in their scopes.
6. Logs never contain payloads, URLs, domains, keys, cookies or emails (pino redaction list).
7. No string SQL with user input (Drizzle query builder and parameters only).
8. No code execution and no regex in rules or saved queries.

Extra row: `At-least-once delivery in, effectively-once storage (UNIQUE key + ON CONFLICT DO NOTHING)` · `Hard delete (backups keep data until they rotate)` · `Postgres RLS planned for v1.1` · `Never connect to Postgres on port 5432 (the user's personal server); the project DB is on 5433`.

---

## DIAGRAM 10: Stack, repository layout, workflow, testing

**Stack** (layered panel):
- Monorepo: pnpm workspaces + Turborepo · TypeScript strict · Node 24 LTS · Biome
- `apps/api`: NestJS 11 (Express 5), Drizzle ORM, PostgreSQL 18, pg-boss, Better Auth, nestjs-zod, nestjs-pino, Zod 4
- `apps/web`: Vite, React 19, TanStack Router + Query, shadcn/ui, Tailwind v4
- `apps/extension`: WXT (MV3), IndexedDB via `idb`
- `apps/e2e`: Firefox (web-ext + Selenium/geckodriver, primary) · Edge smoke (Playwright + Chromium) · local fixture site
- `packages/contracts` (Zod: envelope, event types, DTOs, rule and saved-query formats) · `packages/rules` (pure engine) · `packages/tsconfig`
- Deploy: docker compose (`postgres`, `api`, `worker`; same image for api and worker) + optional Caddy for TLS

Dependency arrows: `contracts → api, web, extension, rules`; `rules → api, extension`.

**Repository tree**: `apps/api` (`src/main.ts`, `src/worker.ts`, `src/modules/{auth, integrations, ingest, rules, events, activity, endpoints, keys, retention, exports, diagnostics}`, `src/platform/{db, jobs, logging, config}`) · `apps/web` · `apps/extension` · `apps/e2e` · `packages/*` · `docs/` (`PLAN.md`, `self-hosting.md`, `event-types.md`, `rule-format.md`, `api.md`, `adr/`) · `spikes/` · `docker-compose.yml` · `CLAUDE.md`.

**Workflow** (grey flow): `read CLAUDE.md + PLAN task + ADRs + neighbouring code` → `branch mx-nn-short-name from main` → `tests first for high/xhigh/security tasks` → `implement` → `pnpm lint && typecheck && test (+ test:int if DB touched)` → `commit (Conventional Commits) → push → PR` → `CI green` → `tick box in PLAN.md` → `squash-merge with user approval`. Rules: never commit to main; the repo is public (no secrets, .env or real browsing data); at 40% context write a handoff and start a new chat.

**Model routing** (3 chips): `H Haiku: setup, config, docs` · `S Sonnet: all implementation and all tests` · `O Opus: reviews only (Mx-R, security pass), helps when stuck`. Effort: low, medium, high, xhigh. Commands: `/task <ID>`, `/milestone <Mx>`. Only Mx-R launches the `reviewer` subagent (Opus).

**Testing**: Vitest (+SWC) · supertest against the Nest app · Testcontainers (fresh DB per run) · fast-check property tests (required for the rule engine and the URL sanitizer) · fixed clocks · two-user cross-tenant fixture on every route · adversarial suite (parallel duplicate posts give 1 row; mid-stream revocation; log-capture) · route-table-generated suite in M7 · CI jobs: lint/typecheck/unit on ubuntu and windows, integration, Firefox e2e, Edge smoke. Note: `Docker is often off locally; integration and e2e always run in CI`.

**Spikes**: A (Chromium service-worker kill ×20, zero lost events), B (e2e harness), C (Firefox event-page lifecycle). The results are in `ADR 0002`.

---

## DIAGRAM 11: Roadmap and status board (horizontal timeline, one column per milestone)

Use the status colors from the legend. Each column is a card with the task list.

- **M0 Foundations and spikes (DONE)**: monorepo scaffold · CI · local infra · NestJS skeleton · DB layer · jobs · Better Auth · extension skeleton · Spike B · Spike A · docs · M0-R
- **M1 Ingestion API (DONE)**: contracts · schema · API keys and tenant scoping · integrations module · POST /v1/ingest/events · heartbeat · adversarial tests · docs · M1-R
- **M2 Extension capture and delivery (DONE)**: cross-browser build · Spike C · Firefox e2e harness · pairing · connect UI · URL sanitizer · capture engine · persistent queue and sync · popup and heartbeat · temporary allow list · e2e · M2-R
- **M3 Dashboard v0 (DONE)**: web scaffold · auth pages · integrations page · events API · events UI · diagnostics and health · polish · M3-R
- **M4 Rules (DONE, review fixes in progress, yellow badge)**: Firefox as the primary e2e · rule format · engine · engine tests · rules API · server enforcement · extension rule sync · rules UI · explainability · e2e for demo steps 3 and 7 · M4-R. Fixes on branch `m4-r-review-fixes`: S1 linear-time glob matcher, S2 refuse config for http keys, S3 collected shortcut only when an allow rule reads a rewritten field, S4 popup verdict on any probe.
- **M5 Query API and user endpoints (OPEN)**: read keys · GET /v1/events · aggregates · saved-query compiler · endpoints CRUD and UI · injection and scope tests · OpenAPI · M5-R
- **M6 Data lifecycle (OPEN)**: retention policies (precedence: set_retention > type policy > source policy > 90-day default) · retention jobs · bulk delete · account deletion · export (NDJSON.gz + manifest) · tests · docs · M6-R
- **M7 Hardening and v1.0 (OPEN)**: full 8-step demo e2e on Firefox · route-table suite · rate limits, helmet, CSRF · security pass and threat model · production packaging (AMO and Edge zips, Dockerfile, Caddy) · docs · release prep (tagging v1.0.0 needs user approval) · M7-R
- **v1.1+ (OPEN, dashed outline)**: webhook `forward` (HMAC, retries, SSRF guard) · GitHub integration · content-script interactions · Postgres RLS · user-defined event types · Chrome support · partitioning

Below the timeline, a decisions strip: `Self-hosted, multi-account` · `Deny by default` · `Domain + path only` · `Firefox first, then Edge, Chrome after v1` · `JSON rules edited via a dashboard form` · `Fixed endpoints + saved queries` · `No element interactions in v1`.

Risks strip (two-column mini table): `MV3 background killed → IndexedDB + alarms` · `Firefox/Edge differences → one browser.* codebase, Firefox is the reference` · `Inflated time-on-site → closed focus segments capped at 30 min` · `Rules change while events are queued → the server re-applies current rules` · `Rule bugs widen collection → deny by default, fail closed, property tests, dry-run` · `tabs permission warning → explain it in onboarding` · `Clock skew → store occurredAt and receivedAt, clamp` · `Scope creep → v1.1`.

---

## Final checklist for the AI before output

- All 11 diagrams are present, each in its own labelled frame, with the board title and legend.
- Every arrow has a label. Colors follow the legend. No text overflows its shape.
- The JSON parses, with unique element ids and bound arrows.
