# Personal API

**Your data. Your endpoints. Your rules.**

Personal API is a self-hosted personal data platform. A browser extension (Firefox first, then
Edge) sends events you choose to share, and your own rules decide what is kept. You read the data
through the dashboard, through built-in API routes, or through saved-query endpoints that you
define. Every account is separate, and nothing is collected until you allow a site.

> **Status:** v1 is in development and not tagged yet. The extension is not on Firefox Add-ons or
> Edge Add-ons yet, so you install it from source (below).

## What it does

- **Deny by default.** A new browser extension collects nothing until a rule allows a site.
- **URLs are reduced.** Only the domain and path are kept. Query strings and `#fragments` are
  stripped, and titles, form contents, keystrokes, passwords and private windows are never collected.
- **Rules you can read.** Each rule is a small JSON document, edited in the dashboard form or as
  JSON. The same engine runs in the extension and on the server, and every stored event records
  which rule kept it.
- **Your own endpoints.** A saved query becomes `GET /v1/me/<slug>`, with a read key that can only
  read that endpoint.
- **Export and delete.** Export your data as gzipped NDJSON, or delete the account and all of its data.

## Self-host with Docker (production)

You need Docker with Compose v2, a domain name that points at your server, and ports 80 and 443
open. The full steps, including TLS, backups and upgrades, are in
[docs/self-hosting.md](docs/self-hosting.md). In short:

```bash
cp .env.example .env.production        # set the secrets and PA_DOMAIN (see the file's comments)
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

**Create the owner account before you expose the server.** The first account can always sign up,
so on a new database the first visitor becomes the owner. [docs/self-hosting.md](docs/self-hosting.md)
gives the order that avoids this.

## Develop locally

You need Node.js 24 (see `.nvmrc`), Docker, and pnpm 11.28.2 (provided by Corepack).

```bash
corepack enable
pnpm install
cp .env.example .env                   # set BETTER_AUTH_SECRET (at least 32 characters)
pnpm db:up                             # Postgres 18 in Docker, on localhost:5433
pnpm db:migrate
pnpm --filter @personal-api/contracts build
pnpm --filter web build
pnpm --filter api build
pnpm --filter api start                # API and dashboard on http://localhost:3000
```

Generate `BETTER_AUTH_SECRET` with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.

Open <http://localhost:3000> and create the first account. With the default `ALLOW_SIGNUP=false`,
only the first account can sign up. The API's routes are described in [docs/api.md](docs/api.md),
and the dashboard runs on its own with `pnpm --filter web dev` (it proxies `/api` and `/v1` to the
API on port 3000).

Postgres runs on port **5433** on purpose. Never point this project at port 5432.

## Install the browser extension from source

Build the extension from this repository. The Firefox build is the reference target.

**Firefox (primary):**

```bash
pnpm --filter extension build:firefox
```

Open `about:debugging`, choose **This Firefox**, then **Load Temporary Add-on**, and select
`apps/extension/.output/firefox-mv3/manifest.json`. A temporary add-on is removed when Firefox
restarts. To run a development build instead, use `pnpm --filter extension dev:firefox`.

**Edge:**

```bash
pnpm --filter extension build:chrome
```

Open `edge://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select
`apps/extension/.output/chrome-mv3`.

Chrome, Brave and Opera are not tested yet. The Edge build may load there, but nothing is verified.

### Connect the extension

1. In the dashboard, open **Integrations** and add a browser extension. It shows a pairing code,
   valid for 10 minutes.
2. In the extension popup, enter your server URL and the code. The popup asks your browser for
   permission to reach that server only.

## Documentation

- [docs/self-hosting.md](docs/self-hosting.md): configuration, TLS, backups and upgrades
- [docs/api.md](docs/api.md): the HTTP API, with examples
- [docs/rule-format.md](docs/rule-format.md): the rule format and the rule engine
- [docs/saved-queries.md](docs/saved-queries.md): saved-query endpoints
- [docs/export-format.md](docs/export-format.md): the export file format
- [docs/data-lifecycle.md](docs/data-lifecycle.md): what is kept, for how long, and what deletion removes
- [docs/threat-model.md](docs/threat-model.md): what the project defends against and what it does not
- [docs/extension-build.md](docs/extension-build.md): building the extension from source
- [docs/PLAN.md](docs/PLAN.md): architecture and the task list

## Development

```bash
pnpm lint            # Biome
pnpm typecheck
pnpm test            # unit tests, no Docker needed
pnpm test:int        # integration tests (Testcontainers, needs Docker)
pnpm test:e2e        # Firefox end-to-end tests (Selenium + geckodriver)
```

The rules and guardrails for contributors are in [CLAUDE.md](CLAUDE.md).
