# Self-hosting

This page collects operational notes for running your own Personal API. It is finalized in M7-06
(TLS, backups, upgrades); until then it records the things you must know before deploying.

## Create the owner account before exposing a fresh deployment

The first account can always sign up, **even with `ALLOW_SIGNUP=false`**. `ALLOW_SIGNUP=false`
only blocks signups once at least one account exists. So on a fresh database, whoever reaches
the sign-up page first becomes the owner.

When you deploy a new instance:

1. Start it where only you can reach it (bound to localhost, behind a firewall, or on a private
   network).
2. Sign up and create your own account.
3. Only then expose it publicly (open the port, point DNS at it, or enable the reverse proxy).

Keep `ALLOW_SIGNUP=false` (the default) unless you deliberately want other people to create
accounts on your server.

## Configuration checks at startup

The API and worker refuse to start if their configuration is unsafe:

- `DATABASE_URL` must name an explicit port other than 5432 and must not carry `host` or `port`
  query parameters (they would override the host and port in the URL).
- With `NODE_ENV=production`, `BETTER_AUTH_URL` must use `https`, unless its host is loopback
  (`localhost`, `127.0.0.1` or `[::1]`). Session cookies are only marked `Secure` on https.

## Error format of the auth routes

Every API route answers errors as RFC 9457 `application/problem+json` with a stable `code`,
except the routes Better Auth serves itself under `/api/auth/*` (sign-in, sign-out, get-session
and so on). Those answer Better Auth's own JSON error body (`{ "code": ..., "message": ... }`).
This is a known exception. The responses this project adds in front of Better Auth are still
problem+json: a refused signup (`auth.signup_disabled`, 403), an oversized body
(`http.payload_too_large`, 413) and an unexpected failure (500).
