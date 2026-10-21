# Personal API

**Your data. Your rules.**

Personal API is a self-hosted personal data platform. A browser extension (Firefox first, then
Edge) sends events you choose to share, and your own rules decide what is kept. You read the data
through the dashboard. Every account is separate, and nothing is collected until you allow a site.

> **Status:** v1 is in development and not tagged yet. The extension is not on Firefox Add-ons or
> Edge Add-ons yet, so you install it from source (below).

## What it does

- **Deny by default.** A new browser extension collects nothing until a rule allows a site.
- **URLs are reduced.** Only the domain and path are kept. Query strings and `#fragments` are
  stripped, and titles, form contents, keystrokes, passwords and private windows are never collected.
- **Rules you can read.** Each rule is a small JSON document, edited in the dashboard form or as
  JSON. The same engine runs in the extension and on the server, and every stored event records
  which rule kept it.
- **Export and delete.** Export your data as gzipped NDJSON, or delete the account and all of its data.
  In v1 these are API-only (`POST /v1/exports`, `DELETE /v1/account`, see [docs/api.md](docs/api.md));
  the dashboard screens come in v1.1.

## For users

You need a running Personal API server (see below) and Firefox or Edge. The extension is not in the
stores yet, so you install it from source (see [Install the browser extension from source](#install-the-browser-extension-from-source)).

1. **Install.** Load the extension in your browser as described below.
2. **Connect.** Open the extension popup, enter your server URL and press **Connect**. The browser asks
   for permission to reach that server only. A dashboard tab opens: sign in if needed, then press
   **Connect this browser**. The tab closes and the popup says "Connected."
3. **Choose what to track.** On first login the setup wizard (`/welcome`) offers three presets:
   **Everything except sensitive sites** (banking, health, email and adult sites are dropped),
   **Only work sites**, or **Choose sites** where you type the domains. Nothing is collected until
   you pick one. You can change the rules any time on the **Rules** page.
4. **Read Insights.** The dashboard home shows today's and this week's time, a 7-day chart and your
   top sites. The popup's **Today** list shows your top 5 sites for today, computed on your device.
   **Stop tracking this site** opens the Rules page with a drop rule for that site ready to save.
5. **Set daily limits.** On **Limits**, add a site and its minutes per day. Use `youtube.com` for that
   site only, or `*.youtube.com` for its subdomains. With 10 minutes left you get a notification
   (once a day, for limits longer than 10 minutes). At the limit you get another notification, the
   extension badge turns red, and the site's tabs move to a **Time's up** page. **5 more minutes** adds
   time, and when that runs out the page blocks again. A **strict** limit has no such button, so it
   holds until local midnight, when every limit resets. A notification shows only the pattern you set.
   The popup shows the time left on each limited site.
6. **Read recommendations.** Insights and each site's page suggest changes from your own last two to four
   weeks, with no outside service. A heavy site can get a stepped limit plan, applied in one click. A
   limit you stayed under all week can be lowered. Time spent late at night can become a schedule
   ("Block 23:00 to 07:00"). **Dismiss** hides a suggestion.
7. **Pause before opening.** In the popup, add the sites you want to pause before opening under
   **Pause before opening** (or use the current site's button), and choose a pause of 5 to 10 seconds.
   Opening one of them shows a short countdown. Then **Continue** opens the site, or **Close this tab**
   closes it. The page you were opening is never stored or sent.
8. **Focus and schedules.** On **Focus**, start a focus session that blocks the sites you list, separated by
   commas, for a number of minutes (45 by default). A schedule blocks sites on the
   weekdays and times you choose, such as 09:00 to 17:00 on weekdays. A blocked site shows a **Time's up**
   page with no override. End a focus session from the same page.

Only the domain and path of a page are kept. Query strings, fragments, titles, form contents and
private windows are never collected.

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
pnpm build                             # contracts, rules, dashboard, API and the extension
pnpm --filter api start                # API and dashboard on http://localhost:3000
```

Generate `BETTER_AUTH_SECRET` with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.

Open <http://localhost:3000> and create the first account. With the default `ALLOW_SIGNUP=false`,
only the first account can sign up. The API's routes are described in [docs/api.md](docs/api.md),
and the dashboard runs on its own with `pnpm --filter web dev` (it proxies `/api` and `/v1` to the
API on port 3000). The Vite dev server is served from <http://localhost:5173>, and the API's CSRF
check refuses a mutation whose `Origin` is not `BETTER_AUTH_URL`. When you use the dev server, set
`BETTER_AUTH_URL=http://localhost:5173` in `.env` and restart the API.

Postgres runs on port **5433** on purpose. Never point this project at port 5432.

## Install the browser extension from source

Build the extension from this repository. The Firefox build is the reference target. Run
`pnpm build` once after `pnpm install` first: the extension imports the `contracts` and `rules`
packages, which must be built before `build:firefox` or `build:chrome` can run.

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

Enter your server URL in the extension popup and press **Connect**. The popup asks your browser for
permission to reach that server only, then opens the dashboard so you can confirm with **Connect this
browser** (see [ADR 0003](docs/adr/0003-one-click-connect.md)).

To connect by hand instead, open **Integrations** in the dashboard, add a browser extension, and
type the pairing code (valid for 10 minutes) with the server URL into the popup.

## Documentation

- [docs/self-hosting.md](docs/self-hosting.md): configuration, TLS, backups and upgrades
- [docs/api.md](docs/api.md): the HTTP API, with examples
- [docs/rule-format.md](docs/rule-format.md): the rule format and the rule engine
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

## License

[GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`).
