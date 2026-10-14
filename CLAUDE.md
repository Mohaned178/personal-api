# Personal API

A self-hosted, multi-account personal data platform. A browser extension for Firefox and Edge (and later other sources) sends events. User-defined rules decide what is collected and kept. Users query their data through built-in endpoints and their own saved-query endpoints.

**Source of truth:** `docs/PLAN.md` holds the architecture, data model, rule format, API and the task list with model tags. Read the relevant section before starting a task, and tick the task's box when it merges. If code and plan disagree, stop and ask. Don't silently follow either.

## Stack

TypeScript (strict) everywhere · Node 24 LTS · pnpm workspaces + Turborepo · Biome

- `apps/api`: NestJS 11 (Express 5 platform), Drizzle ORM, PostgreSQL 18, pg-boss, Better Auth, nestjs-zod, nestjs-pino
- `apps/web`: Vite, React 19, TanStack Router + Query, shadcn/ui, Tailwind v4
- `apps/extension`: WXT (MV3, Firefox + Edge builds; no Chrome Web Store)
- `apps/e2e`: Playwright (loads the unpacked Edge/Chromium build); Firefox smoke via web-ext + Selenium (from M2-00c)
- `packages/contracts`: Zod schemas shared by everything (envelope, event types, DTOs, rule and saved-query formats)
- `packages/rules`: pure rule engine used by both the extension and the API

## Commands

<!-- Created in M0-01. Keep this list accurate; M0-11 checks it. -->

```bash
pnpm install
pnpm db:up / pnpm db:down     # Postgres in Docker on localhost:5433
pnpm db:migrate               # apply Drizzle migrations
pnpm db:generate              # create a migration from schema changes (no-op if none)
pnpm dev                      # api + web + extension in watch mode (from M3-01; not defined yet)
pnpm --filter api dev         # api only: tsc watch (compiles to dist/, does not start the server yet)
pnpm --filter api start       # run the built API (dist/main.js) with ../../.env; run `pnpm --filter api build` first
pnpm --filter extension dev   # extension only: WXT dev build (load .output/chrome-mv3 unpacked)
pnpm worker                   # pg-boss worker (needs the env below; fails closed without it)
pnpm lint / pnpm format       # Biome (format writes files)
pnpm typecheck
pnpm test                     # unit tests (no Docker needed)
pnpm test:int                 # integration tests (Testcontainers, needs Docker)
pnpm e2e:install              # once per machine: Playwright's bundled Chromium
pnpm test:e2e                 # Playwright; builds the extension and the spike first
pnpm --filter extension build # then load apps/extension/.output/chrome-mv3 unpacked
pnpm build                    # turbo build for all packages
```

Env: copy `.env.example` to `.env` (gitignored) before `pnpm db:migrate`, `pnpm worker` or the API.
Set `BETTER_AUTH_SECRET` (at least 32 characters, `openssl rand -base64 32`), `BETTER_AUTH_URL`
(http(s) origin) and `ALLOW_SIGNUP` (`true` or `false`). `DATABASE_URL` points at port 5433.
The API and worker refuse to start if these are missing or invalid.

Layout notes: `spikes/` holds throwaway prototypes that are never shipped (`spikes/mv3-lifecycle`,
Spike A, see `docs/adr/0002-mv3-state-persistence.md`). `docs/adr/` holds architecture decision
records (`0001-stack.md` pins the stack versions and deviations from the plan).

Before calling a task done, run `pnpm lint && pnpm typecheck && pnpm test` in the touched packages, plus `test:int` if you touched the DB.

## Privacy and security invariants (never break these)

1. **Deny by default, fail closed.** If rules are missing, invalid or throw, nothing is collected or stored. A bug must never widen collection.
2. **Dropped events are never stored.** Keep only counters in `ingestion_log`, never payloads.
3. **URLs:** the extension keeps domain + path only. Query strings and fragments are stripped unless a `keep_query` rule matches. Never collect titles, form contents, keystrokes, passwords or incognito tabs.
4. **Tenant scoping:** every query on user data goes through the scoped repository helpers with `userId` from `AuthContext`. Never take `userId` or `integrationId` from the request body. Every new route gets a cross-tenant test (use the two-user fixture).
5. **Keys:** API keys are stored as SHA-256 hashes and shown once. Ingest keys (`pa_ing_`) can only ingest. Read keys (`pa_read_`) can only read within their scopes.
6. **Logs:** never log payloads, URLs, domains, keys, cookies or emails. Extend the pino redaction list rather than working around it.
7. **No string SQL** with user input. Build dynamic queries (saved queries, filters) with Drizzle's query builder and parameters only.
8. **No code execution** in rules or saved queries, and no regex ops in v1.

## Conventions

- **Contracts first:** a new event type, DTO or format starts as a Zod schema in `packages/contracts`, and both sides import it. Never duplicate shapes.
- **Nest:** one module per domain under `apps/api/src/modules/<domain>` (controller, service, repository, `*.spec.ts`). Cross-cutting code goes in `src/platform/` (db, jobs, logging, config).
- **Errors:** RFC 9457 `application/problem+json` with a stable `code` field, for example `ingest.payload_invalid`.
- **Lists:** keyset cursor on `(occurred_at, id)`, never offset.
- **Ingest:** at-least-once in, effectively-once stored through `UNIQUE (user_id, integration_id, client_event_id)` with `ON CONFLICT DO NOTHING`. Job handlers must be idempotent.
- **`packages/rules`** stays pure, with no Node, DOM, chrome or I/O imports, so the extension and server give identical results.
- **Extension:** the MV3 background (Edge service worker, Firefox event page) can be killed at any time. Use WXT's `browser.*`, never raw `chrome.*`. Persist state to IndexedDB or `browser.storage`, use `browser.alarms` (never `setTimeout`/`setInterval` for anything important), and register every listener at the top level.
- Prefer small, boring code over abstractions. Don't add dependencies without a reason in the PR description.

## Testing

- **Sonnet writes the tests.** On `[O]` tasks, tests come first, written from the task's "done when" criteria in `docs/PLAN.md`, before Opus implements.
- Unit: Vitest. API: supertest against the Nest app. DB: Testcontainers (each run gets a fresh database).
- Rule engine and URL sanitizer: fast-check property tests are required.
- Fixed clocks for anything time-based (retention, focus segments, pairing expiry).
- A bug fix starts with a failing test that reproduces it.

## Gotchas

- **Never connect to Postgres on port 5432.** That's the user's own personal server. The project DB is only on 5433 (compose) or Testcontainers.
- Docker is often off on the dev machine (Windows). Integration and e2e tests always run in CI, so say so if you couldn't run them locally. Don't claim they passed.
- Better Auth's route needs the raw body, so exclude it from Nest's global body parser.
- Scripts must be cross-platform (Windows + Linux CI): no bash-only syntax in `package.json`.

## Model and effort routing (automatic)

Each task in `docs/PLAN.md` §10 is tagged `[model · effort]`:

- `H` Haiku: setup, config, docs, simple tasks.
- `S` Sonnet: implementation and all tests.
- `O` Opus: complex or security-critical work, and every review.

Effort is `low` / `medium` / `high` / `xhigh`.

Run work with `/task <ID>` or `/milestone <Mx>` (`.claude/skills/`). The session itself is just a **coordinator** (keep it on Sonnet · medium). It launches the `builder`, `test-writer` and `reviewer` subagents (`.claude/agents/`) with the tag's exact model and effort, so nobody switches `/model` or `/effort` by hand. On `[O]` tasks, `test-writer` (Sonnet · high) writes the failing tests first.

If you're a Haiku or Sonnet builder and hit a design question, an unexplained failure, or anything touching auth, tenant scoping or the invariants above, **report `needs-opus`**. Don't guess. The coordinator escalates one level automatically, and asks the user if that fails too.

## Git

- Branch per task: `mx-nn-short-name` (for example `m1-05-ingest-endpoint`). Never commit or push to `main` directly.
- Conventional Commits (`feat(ingest): …`, `fix(extension): …`, `test(rules): …`, `docs: …`).
- PR to `main`, squash-merge once CI is green. Merges, tags, releases and repo settings need the user's approval.
- The repo is **public**: never commit secrets, `.env` files, real browsing data or personal fixtures.
