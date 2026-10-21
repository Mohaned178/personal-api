# Self-hosting

This page covers running your own Personal API: the first start, configuration, TLS, backups and
upgrades. The production stack is `docker-compose.prod.yml`. It runs Postgres, a one-shot
`migrate` job, the API (which also serves the dashboard), the worker and Caddy for TLS.

## What you need

- A Linux server (or a PC that stays on) with Docker and Compose v2.
- A domain name you control, with an `A` (and `AAAA`) record that points at the server. Caddy
  needs it to get a certificate.
- Ports 80 and 443 open to the internet. Port 80 is used to issue the certificate.
- Somewhere to keep backups, outside the server.

## Create the owner account before exposing a fresh deployment

The first account can always sign up, **even with `ALLOW_SIGNUP=false`**. `ALLOW_SIGNUP=false`
only blocks signups once at least one account exists. So on a fresh database, whoever reaches the
sign-up page first becomes the owner. The steps below create the owner before Caddy starts, so
nobody outside can reach the sign-up page first.

1. Create the secrets file from the example:

   ```bash
   cp .env.example .env.production
   ```

   Set these values in `.env.production`:

   - `POSTGRES_USER`, `POSTGRES_PASSWORD` (letters and digits only), `POSTGRES_DB`
   - `BETTER_AUTH_SECRET`: at least 32 characters, from `openssl rand -base64 32`
   - `BETTER_AUTH_URL=https://pa.example.com` (your domain, with `https://`)
   - `PA_DOMAIN=pa.example.com` (the same domain, without the scheme)
   - `ALLOW_SIGNUP=false` (the default)

2. Start everything except Caddy. Nothing is published on the host yet: only Caddy publishes
   ports, so the API cannot be reached from outside.

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build postgres migrate api worker
   ```

3. Create the owner from inside the API container. Replace the email and password with yours.
   The `Origin` header must match `BETTER_AUTH_URL`, or the CSRF check refuses the request.

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production exec api node -e 'fetch("http://127.0.0.1:3000/api/auth/sign-up/email",{method:"POST",headers:{"content-type":"application/json",origin:process.env.BETTER_AUTH_URL},body:JSON.stringify({email:"you@example.com",password:"use-a-long-passphrase",name:"You"})}).then(async r=>console.log(r.status))'
   ```

   It prints `200`. A second attempt prints `403` (`auth.signup_disabled`). The password is in
   your shell history: clear it, or run the command from a file.

4. Start Caddy, which publishes the server:

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production up -d caddy
   ```

   Then open `https://pa.example.com` and sign in.

**Do not run a plain `docker compose ... up -d` on a fresh database before step 3.** Without a
service list it starts Caddy too, and the sign-up page is then public.

Keep `ALLOW_SIGNUP=false` (the default) unless you deliberately want other people to create
accounts on your server.

Steps 1 to 3 were run against a local copy of the production stack. Step 4 needs a public domain,
so the certificate issuance was not run here. The Caddyfile was checked with `caddy validate`.

## Configuration

The API and the worker read these variables. The API and worker refuse to start if a required
value is missing or invalid.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | none | Must name an explicit port other than 5432, and must not carry `host` or `port` query parameters. The production compose file builds it from the `POSTGRES_*` values. |
| `BETTER_AUTH_SECRET` | yes | none | At least 32 characters. It signs the session cookies, so changing it signs everyone out. |
| `BETTER_AUTH_URL` | yes | none | The public origin, for example `https://pa.example.com`. With `NODE_ENV=production` it must be `https`, unless its host is loopback. Session cookies are `Secure` only on https. |
| `ALLOW_SIGNUP` | no | `false` | `true` or `false` only. With `false`, only the first account can sign up. |
| `TRUST_PROXY` | no | `0` | How many reverse proxies sit in front of the API (at most 10). Behind Caddy, set `1`; the production compose file does. Setting it higher than the real count lets a client choose its own address for rate limits. |
| `EXPORT_DIR` | no | `data/exports` | Where export files are written. The API and the worker must share this directory. The Docker image uses `/data/exports`, a volume shared by both. |
| `WEB_DIST_DIR` | no | `apps/web/dist` | The built dashboard. The Docker image sets `/app/web/dist`. |
| `PORT` | no | `3000` | The HTTP port inside the container. The production stack does not publish it. |
| `LOG_LEVEL` | no | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. Logs never contain payloads, URLs, domains or keys, whatever the level. |
| `NODE_ENV` | no | `development` | The production compose file sets `production`, which enables the HTTPS check above. |

The `.env.example` file lists the same variables with dev values, and `PA_DOMAIN` is used only by
the production compose file.

## TLS

Caddy gets a certificate from Let's Encrypt for `PA_DOMAIN` and renews it itself. It needs the DNS
record in place, ports 80 and 443 open, and `PA_DOMAIN` set before the first start. The Caddy
configuration is `deploy/Caddyfile`. It forwards every request to the API, which serves the
dashboard too.

Certificate state lives in the `caddy_data` volume. If you lose it, Caddy requests a new
certificate. Don't recreate the volume often: Let's Encrypt limits how many certificates a domain
can get in a week.

If you put another reverse proxy in front of the API instead of Caddy, set `TRUST_PROXY` to the
number of proxies, forward to the API on port 3000, and keep port 3000 reachable only from that
proxy.

## Rate limits

Sign-in and sign-up allow 3 attempts per 10 seconds per client address, whatever `NODE_ENV` is
(only the test suites turn this off). Pairing allows 10 attempts a minute per address. Each ingest
key gets 120 requests a minute. The counters live in memory, so a restart resets
them. Behind a reverse proxy, set `TRUST_PROXY` to the number of proxies in front, and no higher:
a higher value lets a client pick its own address. See `docs/threat-model.md`.

## Backups

Back up two things:

1. **The database.** Take a custom-format dump from the `postgres` service. Use `-p 5433`: the
   database listens on 5433 inside the container, and a plain `pg_dump` (which uses 5432) fails.
   Replace the names with the values from `.env.production`.

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres pg_dump -U <POSTGRES_USER> -p 5433 -d <POSTGRES_DB> -Fc > pa-backup.dump
   ```

   Restore it into an empty database. Create the database first, then restore into it:

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres createdb -U <POSTGRES_USER> -p 5433 <NEW_DB>
   docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres pg_restore -U <POSTGRES_USER> -p 5433 -d <NEW_DB> < pa-backup.dump
   ```

   Stop `api` and `worker` before you restore over a database that is in use. The dump holds
   password hashes and hashed keys, so store it as carefully as the database itself. Run the
   restore once a month to be sure the backup works. The round trip above was run against a copy
   of the stack.

2. **`.env.production`.** It holds `BETTER_AUTH_SECRET`. A new server with a different secret
   signs everyone out, and the file is a secret, so keep it in a password manager, not in the
   repository.

Export files are not in the database dump, and they do not need a backup: each one is removed 24
hours after it finishes. Export requests are rows in the database, so the dump has them.

Deletion removes data from the live database at once, but **backups keep deleted data until
they rotate.** Set a backup retention that fits you, and see
[data-lifecycle.md](data-lifecycle.md#backups).

## Upgrades

Upgrades rebuild the image from the new code and apply any new database migrations first.

1. Take a database backup (see above).
2. Update the code: `git pull` in the checkout you deployed from.
3. Rebuild and start:

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
   ```

   Compose recreates each container whose image changed. `migrate` runs first, and `api` and
   `worker` start only after it exits with success. If `migrate` fails, the others do not start:
   read `docker compose ... logs migrate`.

4. Check the result: `docker compose ... ps` shows `api` as `healthy`, and
   `https://<PA_DOMAIN>/healthz` returns `200`. `/readyz` also checks the database and the queue.

**Migrations only move forward.** The project has no down migrations. To roll back, stop the
stack, check out the previous version, and restore the backup you took in step 1. Data written
after that backup is lost.

## Operating the stack

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production ps
docker compose -f docker-compose.prod.yml --env-file .env.production logs -f api worker
```

`/healthz` and `/readyz` are public and say nothing about your data. Logs never contain payloads,
URLs, domains or keys.

## Error format of the auth routes

Every API route answers errors as RFC 9457 `application/problem+json` with a stable `code`,
except the routes Better Auth serves itself under `/api/auth/*` (sign-in, sign-out, get-session
and so on). Those answer Better Auth's own JSON error body (`{ "code": ..., "message": ... }`).
This is a known exception. The responses this project adds in front of Better Auth are still
problem+json: a refused signup (`auth.signup_disabled`, 403), an oversized body
(`http.payload_too_large`, 413) and an unexpected failure (500).
