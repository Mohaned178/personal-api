# ADR 0001: Stack and pinned versions

- **Status:** Accepted (M0-11, 2026-10-14).
- **Source:** `docs/PLAN.md` §2 (tech stack). This ADR records what was actually pinned and where it
  deviates.
- **Affects:** every package; revisit Node after 2026-10-28 (deviation 3).

## Context

PLAN §2 chose the stack. M0 scaffolded it and had to pin exact versions, using releases at least
14 days old. Some choices could not be kept as written, because of peer dependency ranges or
upstream lifecycle changes. This ADR records the pins and those deviations so later tasks do not
rediscover them.

## Decision

Keep the stack in PLAN §2, with the deviations below. Pins live in the `package.json` files and
`pnpm-lock.yaml`; this table is a snapshot.

### Pinned versions

| Concern | Package or runtime | Pinned version | Where |
| --- | --- | --- | --- |
| Runtime | Node.js | 24.x (`engines` `>=24 <25`) | `.nvmrc`, root `package.json` |
| Package manager | pnpm | 11.28.2 | root `packageManager` |
| Language | TypeScript | 6.0.3 | root and every package |
| API framework | `@nestjs/core`, `common`, `platform-express`, `testing` | 11.2.6 | `apps/api` |
| HTTP platform | Express | 5.2.1 (`@types/express` 5.0.6) | `apps/api` |
| ORM | drizzle-orm / drizzle-kit | 0.45.3 / 0.31.11 | `apps/api` |
| Database driver | pg (`@types/pg` 8.23.1) | 8.23.0 | `apps/api` |
| Database | PostgreSQL | 18.6 (image `postgres:18.6`) | `docker-compose.yml` |
| Job queue | pg-boss | 12.35.0 | `apps/api` |
| Dashboard auth | better-auth | 1.7.6 | `apps/api` |
| Security headers | helmet | 8.3.0 | `apps/api` |
| Contracts | zod | 4.6.5 | `apps/api` (contracts package to follow) |
| Logging | nestjs-pino / pino / pino-http | 5.2.1 / 10.3.1 / 11.0.0 | `apps/api` |
| Unit and integration tests | vitest | 5.0.2 | `apps/api`, `apps/extension`, `spikes/mv3-lifecycle` |
| Nest decorator compile | unplugin-swc / @swc/core | 2.0.0 / 1.16.2 | `apps/api` |
| HTTP tests | supertest | 7.3.0 | `apps/api` |
| Containers in tests | @testcontainers/postgresql | 12.2.0 | `apps/api` |
| Extension | WXT | 0.21.4 | `apps/extension`, `spikes/mv3-lifecycle` |
| End to end | @playwright/test (bundled Chromium) | 1.63.0 | `apps/e2e` |
| Lint and format | @biomejs/biome | 2.5.14 | root |
| Monorepo tasks | turbo | 2.11.5 | root |

### Deviations from the plan

1. **NestJS 11 instead of 12.** `nestjs-zod`'s peer dependency range only allows `^10 || ^11`, so
   Nest 12 would force an unsupported peer. Nest 11.2.6 is pinned. Revisit when `nestjs-zod`
   supports 12.
2. **TypeScript 6 instead of 7.** Better Auth and `@nestjs/swagger` peer ranges do not yet allow
   TypeScript 7. TypeScript 6.0.3 is pinned.
3. **Node 24 is now Maintenance LTS** (from 2026-10-20). The project stays on Node 24 for M0 to
   M6, and **v1.0 ships on Node 24** (decided at the M7-R review, 2026-10-20). Node 26 becomes LTS
   on 2026-10-28; revisit the runtime after that date, and move the `engines` and `.nvmrc` only in
   a deliberate change.
4. **Better Auth is mounted by hand**, not through `@thallesp/nestjs-better-auth`. The signup gate
   (`ALLOW_SIGNUP`) has to wrap the request before Better Auth sees it, and the wrapper package
   does not offer that hook. Better Auth's route also needs the raw body, so it is excluded from
   Nest's global body parser.
5. **Spike A used raw IndexedDB; production uses `idb`.** The spike is a throwaway package and
   avoided a dependency. M2-05 adds `idb` as PLAN §2 says, because it supports the `durability`
   option and the read-compute-write transaction pattern (see ADR 0002). `idb` is not yet in any
   package.
6. **`nestjs-zod` and `@nestjs/swagger` arrived with the first DTOs and the API docs task.**
   `@nestjs/swagger` is pinned exactly at 11.4.7 (M5-07) and serves OpenAPI at `/docs`. Swagger's
   routes bypass Nest's guards, pipes and filters, so `/docs` is public. It lists request shapes
   only, from the Zod DTOs through nestjs-zod's `cleanupOpenApiDoc`. Its `@scarf/scarf` telemetry
   postinstall is disabled in `pnpm-workspace.yaml`.
7. **Dependency age policy.** `pnpm-workspace.yaml` sets `minimumReleaseAge: 20160` (14 days, in
   minutes), so pnpm refuses versions published less than 14 days ago. Build scripts are blocked
   unless listed in `allowBuilds`.
8. **Postgres 18 volume path.** The PG 18 image stores data under `/var/lib/postgresql`, so the
   compose volume mounts the parent directory, not `/var/lib/postgresql/data`. Dev port is 5433.
9. **Bundled Chromium for e2e.** Playwright uses its own bundled Chromium (`pnpm e2e:install`), not
   the system Chrome, so runs are reproducible across machines and CI. The extension is loaded
   unpacked into that browser.

10. **Our own rate limiter instead of `@nestjs/throttler`.** PLAN §2 listed the throttler. The
    limits need a per-key budget (ingest and read keys), a per-address budget behind
    `TRUST_PROXY`, and a clock the tests can fix. A small in-process `RateLimiter`
    (`apps/api/src/platform/rate-limit`) does that with no extra dependency, and Better Auth's own
    limiter covers login. Limits are per process, which fits the single-instance deployment.

## Consequences

- Upgrading any pinned version is a deliberate change: check the peer ranges and the 14-day rule
  first.
- Deviations 1, 2 and 3 are time-bound. Each has a named trigger to revisit.
- Deviations 4 and 5 are design choices and stay unless the reason changes.
