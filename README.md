# Personal API

**Your data. Your rules.**

[![CI](https://github.com/Mohaned178/personal-api/actions/workflows/ci.yml/badge.svg)](https://github.com/Mohaned178/personal-api/actions/workflows/ci.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)

A private, self-hosted browsing-time tracker that helps you change your habits. A browser extension
sends the visits **you** allow to a server **you** run. You see where your time goes, set daily limits,
block distracting sites and get suggestions, and none of it leaves your own machine.

- **Deny by default.** Nothing is collected until a rule allows a site.
- **Minimal data.** Only the domain and path of a page, never the query string, titles, form
  contents, keystrokes, passwords or private windows.
- **No outside services.** Limits, focus, recommendations and summaries are computed on your device or
  your own server. No accounts elsewhere, no analytics, no AI service.
- **Multi-account.** Every account on a server is separate.

> **Status:** `v1.0.0` is tagged. Daily limits, focus mode, recommendations and the rest of
> [v1.2](CHANGELOG.md) are on `main` and not released yet. The extension is not in the Firefox or Edge
> stores, so you [install it from source](#install-the-browser-extension).

## Contents

- [What you get](#what-you-get)
- [Privacy](#privacy)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Install the browser extension](#install-the-browser-extension)
- [Using it](#using-it)
- [Self-host with Docker](#self-host-with-docker)
- [Project layout](#project-layout)
- [Development](#development)
- [Documentation](#documentation)
- [License](#license)

## What you get

| Feature | What it does |
| --- | --- |
| **Insights** | Today and this week, a 7-day chart, top sites, and a split into productive, neutral and distracting time. |
| **Detailed dashboard** | A page per site (time per day, visits, average and longest session, top paths), an hour-by-weekday heatmap, this week against last, and a timeline of today's sessions. In your time zone. |
| **Daily limits** | Minutes per site per day, enforced on your device. A notification with 10 minutes left, another at the limit, a red badge, and a "Time's up" page with "5 more minutes" (or no way out, in strict mode). Resets at local midnight. |
| **Focus mode and schedules** | Block sites for the next 45 minutes, or every weekday from 09:00 to 17:00. No override. |
| **Pause before opening** | Pick sites that first show a 5 to 10 second countdown, then ask "Still want to open it?". |
| **Recommendations** | Suggestions from your own last two to four weeks: a stepped limit plan for a heavy site, a lower limit you stayed under, a late-night block. Applied in one click, or dismissed. |
| **Categories, goals, weekly summary** | An editable list of productive and distracting sites, goals such as "under 1h of distracting sites a day" with a streak, and this week against last. |
| **Rules you can read** | Each rule is a small JSON document, edited in a form or as JSON, run by the same engine in the extension and on the server. Every stored event records which rule kept it. |
| **Your data is yours** | Set how long events are kept, export them as gzipped NDJSON, or delete the account and everything in it. Export and account deletion are API-only for now ([docs/api.md](docs/api.md)). |

## Privacy

The rules behind this project are written down and tested ([CLAUDE.md](CLAUDE.md),
[threat model](docs/threat-model.md)).

| | |
| --- | --- |
| **Kept** | The domain and path of pages your rules allow, how long you spent on them, and when. |
| **Never collected** | Query strings and `#fragments`, page titles, form contents, keystrokes, passwords, and anything in a private window. |
| **Dropped events** | Never stored. Only counters (how many) are kept, never payloads. |
| **If anything is wrong** | If the rules are missing, invalid or fail, nothing is collected. The extension reads its config strictly and refuses what it does not understand, so [update the extension together with the server](docs/self-hosting.md#upgrades). |
| **Your server** | The only API key is an ingest key that can only send events, and it is stored as a hash. Reading data needs a dashboard login. |
| **Logs** | Never contain payloads, URLs, domains, keys, cookies or emails. |
| **Extension permissions** | `tabs`, `idle`, `storage`, `alarms`, `notifications`, and access to your server's address, requested when you connect. No content scripts, no access to all sites. |

## How it works

```
 Browser extension (Firefox, Edge)                 Your server
┌──────────────────────────────────┐          ┌──────────────────────────────┐
│ tabs and idle events             │          │ API (NestJS)                 │
│   → keep domain + path only      │  HTTPS   │   ingest, rules, activity,   │
│   → your rules decide (allow     │ ───────► │   limits, focus, exports     │
│     or drop, fail closed)        │  ingest  │ Worker (pg-boss)             │
│   → queue on the device          │   key    │   retention, delete, export  │
│                                  │          │ PostgreSQL 18                │
│ limits, focus, pause: enforced   │ ◄─────── │ Dashboard (React), served by │
│ on the device                    │  rules   │   the API, behind a login    │
└──────────────────────────────────┘          └──────────────────────────────┘
```

1. The extension turns tab activity into events and keeps only the domain and path.
2. Your rules, which the extension fetches from your server, decide what is kept. The server applies
   them again, so a bug on one side never widens collection.
3. Events wait in a local queue and are sent in batches. Delivery is at-least-once and storage is
   effectively-once, so a retry never stores a visit twice.
4. Limits, focus sessions and the pause run on the device from data it already has. The server only
   stores your settings and hands them out with the rules.
5. You read everything in the dashboard, behind a login session.

More in [docs/PLAN.md](docs/PLAN.md) and the [architecture decisions](docs/adr).

## Quick start

Run it on your own machine. You need Node.js 24 (`.nvmrc`), pnpm (via Corepack) and Docker.

```bash
corepack enable
pnpm install
cp .env.example .env     # set BETTER_AUTH_SECRET, at least 32 characters
pnpm db:up               # PostgreSQL 18 in Docker, on localhost:5433
pnpm db:migrate
pnpm build               # contracts, rules, API, dashboard and extension
pnpm --filter api start  # API and dashboard on http://localhost:3000
```

Generate the secret with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.

Open <http://localhost:3000> and create the first account. The first account can always sign up.
After that, new sign-ups are closed unless you set `ALLOW_SIGNUP=true`.

The database runs on port **5433** on purpose. Never point this project at port 5432.

## Install the browser extension

Build it from this repository. Run `pnpm build` once first, because the extension imports the
`contracts` and `rules` packages.

**Firefox (the reference browser, 140 or newer):**

```bash
pnpm --filter extension build:firefox
```

Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and pick
`apps/extension/.output/firefox-mv3/manifest.json`. A temporary add-on is removed when Firefox
restarts. For development with live reload, run `pnpm --filter extension dev:firefox`.

**Edge:**

```bash
pnpm --filter extension build:chrome
```

Open `edge://extensions`, turn on **Developer mode**, choose **Load unpacked**, and pick
`apps/extension/.output/chrome-mv3`. Chrome, Brave and Opera are not tested yet.

**Connect it.** Open the extension popup, type your server address (for example
`http://localhost:3000`) and press **Connect**. Your browser asks for access to that address only.
A dashboard tab opens: sign in, press **Connect this browser**, and the tab closes
([ADR 0003](docs/adr/0003-one-click-connect.md)). To connect by hand instead, add a browser extension
under **Integrations** and enter the pairing code, which is valid for 10 minutes.

## Using it

1. **Pick what to track.** The first time you log in, the setup page offers three presets:
   everything except sensitive sites (banking, health, email and adult sites are dropped), only work
   sites, or sites you type in. Nothing is collected until you pick one, and you can change the rules
   any time on **Rules**.
2. **Look at Insights.** The popup's **Today** shows your top 5 sites, computed on your device.
   **Stop tracking this site** opens Rules with a drop rule ready to save.
3. **Set a daily limit** on **Limits**. Use `youtube.com` for that site only and `*.youtube.com` for
   its subdomains. A **strict** limit has no "5 more minutes" button.
4. **Block** sites on **Focus** with a one-off session or a weekly schedule. The block applies within
   about a minute.
5. **Pause before opening** is set in the popup, for the sites you pick.
6. **Sort your sites** on **Categories**, set goals, and read **Summary** at the end of the week.
7. **Recommendations** appear on Insights once you have about two weeks of data.

## Self-host with Docker

For a server other people can reach, you need Docker with Compose v2, a domain that points at the
server, and ports 80 and 443 open:

```bash
cp .env.example .env.production   # set the secrets and PA_DOMAIN (see the file's comments)
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

**Create the owner account before you expose the server**, because the first visitor to a new database
becomes the owner. [docs/self-hosting.md](docs/self-hosting.md) gives the safe order, and covers TLS,
backups and upgrades.

## Project layout

```
apps/api         NestJS 11, Drizzle ORM, PostgreSQL 18, pg-boss, Better Auth
apps/web         The dashboard: Vite, React 19, TanStack Router and Query, shadcn/ui, Tailwind v4
apps/extension   WXT (Manifest V3): Firefox is the reference build, Edge uses the Chromium build
apps/e2e         Firefox end-to-end tests (Selenium), and an Edge smoke test (Playwright)
packages/contracts   Zod schemas shared by everything: events, API shapes, rules
packages/rules       The pure rule engine, used by both the extension and the API
docs/            Plan, API, rule format, threat model, self-hosting, decision records
```

TypeScript (strict) everywhere, with pnpm workspaces, Turborepo and Biome.

## Development

```bash
pnpm lint            # Biome
pnpm typecheck
pnpm test            # unit tests, no Docker needed
pnpm test:int        # integration tests (Testcontainers, needs Docker)
pnpm test:e2e        # Firefox end-to-end tests
pnpm --filter web dev   # dashboard dev server (proxies /api and /v1 to :3000)
```

When you use the Vite dev server on `localhost:5173`, set `BETTER_AUTH_URL=http://localhost:5173` in
`.env` and restart the API, because the login check only trusts that one address.

The rules for contributors, including the privacy invariants no change may break, are in
[CLAUDE.md](CLAUDE.md). Work is planned in [docs/PLAN.md](docs/PLAN.md), and each change is a small
pull request with tests.

## Documentation

- [CHANGELOG.md](CHANGELOG.md): what changed in each version
- [docs/self-hosting.md](docs/self-hosting.md): configuration, TLS, backups and upgrades
- [docs/api.md](docs/api.md): the HTTP API, with examples
- [docs/rule-format.md](docs/rule-format.md): the rule format and the rule engine
- [docs/event-types.md](docs/event-types.md): the events the extension sends
- [docs/export-format.md](docs/export-format.md): the export file format
- [docs/data-lifecycle.md](docs/data-lifecycle.md): what is kept, for how long, and what deleting removes
- [docs/threat-model.md](docs/threat-model.md): what the project defends against and what it does not
- [docs/extension-build.md](docs/extension-build.md): building the extension from source
- [docs/PLAN.md](docs/PLAN.md): architecture and the task list

## License

[GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`).
