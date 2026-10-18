# API quick start

Examples for a local API. Every request below was run against a local API on
`http://localhost:3000` (the `BETTER_AUTH_URL` from `.env.example`), with `ALLOW_SIGNUP=true`.

Keys in these examples are placeholders. Your real ingest key is shown once, in the response
to creating an integration, and the server keeps only its SHA-256 hash.

```bash
export BASE=http://localhost:3000
export JAR=$(mktemp)            # cookie jar for the dashboard session
```

## 1. Sign up

Dashboard auth is Better Auth, mounted at `/api/auth`. Its state-changing routes check the
`Origin` header against `BETTER_AUTH_URL`, so send it with the same origin. With
`ALLOW_SIGNUP=false` only the first account can be created; other attempts get
`403 auth.signup_disabled`.

```bash
curl -s -X POST "$BASE/api/auth/sign-up/email" \
  -H "Origin: $BASE" \
  -H "Content-Type: application/json" \
  -c "$JAR" \
  -d '{"email":"you@example.com","password":"use-a-long-passphrase","name":"You"}'
```

The response is `200` with `{ "token": "...", "user": { ... } }` and a `better-auth.session_token`
cookie, which is written to `$JAR`. To sign in later, use `/api/auth/sign-in/email` with the
same body shape (email and password) and `-c "$JAR"`.

## 2. Create an `http` integration

`POST /v1/integrations` needs the session cookie (`-b "$JAR"`). The integration belongs to the
signed-in user; the body cannot name a user. Only `kind: "http"` is accepted here (browser
integrations come from pairing, M2-01). New integrations start with `defaultPolicy: "deny"`.

```bash
curl -s -X POST "$BASE/v1/integrations" \
  -H "Content-Type: application/json" \
  -b "$JAR" \
  -d '{"kind":"http","name":"Work laptop"}'
```

```json
{
  "integration": {
    "id": "01a13ab2-9115-7297-97ce-f317f4310b8e",
    "kind": "http",
    "name": "Work laptop",
    "defaultPolicy": "deny",
    "status": "active",
    "lastSeenAt": null,
    "createdAt": "2026-10-14T13:55:43.507Z"
  },
  "ingestKey": {
    "id": "01a13ab2-9117-7147-b880-4b6e29a01fec",
    "key": "pa_ing_<shown-once-placeholder>",
    "prefix": "pa_ing_<first-6-chars>"
  }
}
```

**The `ingestKey.key` is shown only in this response.** Store it now. The response is
`Cache-Control: no-store`. If you lose it, revoke the integration and create a new one (there is
no key listing endpoint).

Set the key for the next calls:

```bash
export KEY=pa_ing_<paste-the-key-from-the-previous-response>
```

## 3. Ingest a batch

`POST /v1/ingest/events` takes `Authorization: Bearer <ingest key>`. The key decides the user and
the integration; the body cannot set them. A batch holds 1 to 100 events and the body is at most
256 KB. Each event is checked on its own, so one bad event does not fail the batch.

```bash
curl -s -X POST "$BASE/v1/ingest/events" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [
      {
        "id": "0190f5a8-7c1e-7a2b-9d3f-4b5c6d7e8f90",
        "type": "browser.page_visited",
        "typeVersion": 1,
        "occurredAt": "2026-10-13T10:00:00.000Z",
        "data": { "domain": "example.com", "path": "/docs/start", "transition": "link", "tabRef": "k3j2h1g4f5d6a7b8" },
        "meta": { "ruleSetVersion": 0, "client": "curl-example" }
      },
      {
        "id": "0190f5a8-7c1e-7a2b-9d3f-4b5c6d7e8f91",
        "type": "browser.page_visited",
        "typeVersion": 1,
        "occurredAt": "2026-10-13T10:00:00.000Z",
        "data": { "domain": "example.com", "path": "/?q=1", "tabRef": "k3j2h1g4f5d6a7b8" }
      }
    ]
  }'
```

Response: `200` with one result per event, in request order:

```json
{
  "results": [
    { "id": "0190f5a8-7c1e-7a2b-9d3f-4b5c6d7e8f90", "status": "accepted" },
    { "id": "0190f5a8-7c1e-7a2b-9d3f-4b5c6d7e8f91", "status": "rejected", "code": "ingest.payload_invalid" }
  ]
}
```

- `accepted`: stored now.
- `duplicate`: this `id` was already stored for this integration (safe to resend).
- `dropped`: refused by your rules, or by the integration's default policy when no rule
  decided; only a counter is kept (per rule id, or `default_policy`), never the payload. Do not
  resend it: the same event is dropped again until the rules change.
- `rejected`: invalid; `code` says why. The second event above has a query string in `path`,
  so it is rejected.

Sending the same batch again returns `duplicate` for each stored event, so retries are safe.

## 4. Heartbeat

`POST /v1/ingest/heartbeat` reports queue health and updates `lastSeenAt`. It uses the same
Bearer ingest key. All four fields are required. Success is `204 No Content` with no body.

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/v1/ingest/heartbeat" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"queueDepth":0,"oldestQueuedAgeMs":0,"droppedCount":0,"clientVersion":"0.1.0"}'
```

### The rules the extension runs

`GET /v1/ingest/config` (same Bearer ingest key) returns your enabled collect rules, the rule-set
version and the integration's default policy, with a strong `ETag`. Only the key of a
`browser-extension` integration may call it: an `http` integration's key gets
`403 ingest.config_unsupported`, because only an extension applies rules itself. The browser extension polls it
with `If-None-Match`; a match is `304` with no body. The format and the extension's behaviour are
in [rule-format.md](rule-format.md#extension-sync-m4-06).

```bash
curl -s "$BASE/v1/ingest/config" -H "Authorization: Bearer $KEY"
# {"ruleSetVersion":0,"defaultPolicy":"deny","rules":[]}
```

## 5. Read an integration (dashboard)

```bash
curl -s "$BASE/v1/integrations/<integration-id>" -b "$JAR"
```

Use `GET /v1/integrations` for the list. `lastSeenAt` shows the last heartbeat or batch.

## 6. Rules (dashboard)

All rule routes need the session cookie. A rule is the document in [rule-format.md](rule-format.md);
the server sets its `id` and owner, so a body with `id` or `userId` is a `400`.

```bash
# Create (201): { "rule": { "id": …, … }, "version": 1 }
curl -s -X POST "$BASE/v1/rules" -b "$JAR" -H "Content-Type: application/json" -d '{
  "name": "Track GitHub", "enabled": true, "priority": 10, "stage": "collect",
  "when": { "all": [{ "field": "data.domain", "op": "eq", "value": "github.com" }] },
  "then": [{ "action": "allow" }]
}'
curl -s "$BASE/v1/rules" -b "$JAR"                 # { "version": 1, "rules": [ … ] } by priority, then id
curl -s "$BASE/v1/rules/<rule-id>" -b "$JAR"       # { "rule": …, "version": 1 }
curl -s -X PUT "$BASE/v1/rules/<rule-id>" -b "$JAR" -H "Content-Type: application/json" -d '<whole definition>'
curl -s -X DELETE "$BASE/v1/rules/<rule-id>" -b "$JAR"   # { "version": 3 }
```

- **Version.** `version` is the rule-set version. It is 0 until the first change and goes up by one on
  every create, replace and delete (never on a refused change). The same transaction writes a
  `rule_history` snapshot of all the user's rules at that version, so an old event's trace stays
  explainable after a rule changed or was deleted.
- **Limit.** A user can have 100 rules; the 101st is `409 rule.limit_reached`.
- **Validation** is the contracts' `ruleDefinitionSchema`, the same one the engine and the extension use.
  `400 request.invalid` lists `issues` (path and fixed message, never the rule's values).

### Dry run

`POST /v1/rules/test` runs the engine on a sample event. It stores, counts and logs nothing.

```json
{
  "event": { "id": "…", "type": "browser.page_visited", "typeVersion": 1, "occurredAt": "…", "data": { … } },
  "source": "browser-extension",
  "defaultPolicy": "deny",
  "rule": { "…": "an unsaved draft, optional" },
  "replaceRuleId": "swap the draft in for this saved rule, optional",
  "onlyRule": false
}
```

It answers with the engine's decision: `{ "decision": "allow", "event", "tags", "retentionDays", "keepQuery", "trace" }`,
`{ "decision": "drop", "trace" }` or `{ "decision": "error", "reason" }`. `defaultPolicy` defaults to
`deny`. Without `rule`, the saved rules run. With `rule`, the draft runs together with them, or in place
of `replaceRuleId`, or alone with `onlyRule: true`. `replaceRuleId` and `onlyRule` need a `rule`, and
cannot be combined. `trace.ruleSetVersion` is the saved version; a draft without a `replaceRuleId`
shows up in the trace as `00000000-0000-4000-8000-000000000000`.

### Drop counts per rule

`GET /v1/diagnostics?hours=168` (session cookie, 1 to 168 hours, 24 by default) also returns what was
dropped over the window, counted by what decided. The Rules page reads it for its "Dropped (7 days)"
column.

```json
"drops": { "byRule": { "<rule-id>": 7 }, "defaultPolicy": 3 }
```

`byRule` is keyed by rule id and `defaultPolicy` counts the events no rule decided. These are counters
only: no payload, domain or URL is kept for a dropped event. A deleted rule's id can still appear, and
the dashboard shows only the rules it knows.

## Error codes

Errors are `application/problem+json` (RFC 9457) with a stable `code`:

```json
{ "type": "about:blank", "title": "Invalid API key", "status": 401, "code": "auth.invalid_key" }
```

### Per-event codes (`rejected` items in an ingest response)

| Code                            | Meaning                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `ingest.envelope_invalid`       | The envelope fails the schema: bad `id`, `occurredAt`, unknown keys, or a missing field. |
| `ingest.type_unknown`           | `type` is not a registered event type.                                                  |
| `ingest.type_version_unknown`   | `typeVersion` is not registered for that type.                                          |
| `ingest.payload_invalid`        | `data` fails the schema for that type (for example a `path` with `?`, or an unknown key). |
| `ingest.occurred_at_too_old`    | `occurredAt` is older than the accepted window.                                         |
| `ingest.rule_error`             | Your rules could not be run on this event (a stored rule is invalid, or the engine failed). Nothing is stored. |

### Whole-request codes

| HTTP | Code                       | When                                                                                   |
| ---- | -------------------------- | -------------------------------------------------------------------------------------- |
| 400  | `ingest.batch_invalid`     | The batch has no `events` array, an empty one, more than 100 events, or an unknown top-level key. |
| 400  | `request.invalid`          | A request body fails validation (for example the heartbeat or an integration create).  |
| 401  | `auth.invalid_key`         | The Bearer ingest key is missing, malformed, unknown or revoked.                       |
| 401  | `auth.unauthenticated`     | A dashboard route was called without a valid session cookie.                           |
| 403  | `auth.signup_disabled`     | Sign-up is closed (`ALLOW_SIGNUP=false` and an account already exists).                 |
| 403  | `ingest.config_unsupported` | `GET /v1/ingest/config` only: the key belongs to an `http` integration, not a browser extension. |
| 404  | `integration.not_found`    | The integration id is unknown, belongs to another user, or is malformed (all look the same). |
| 404  | `rule.not_found`           | The rule id is unknown, belongs to another user, or is malformed (all look the same). |
| 409  | `rule.limit_reached`       | The user already has 100 rules.                                                        |
| 409  | `ingest.rule_error`        | `GET /v1/ingest/config` only: a stored rule is invalid, so no rules are sent.          |
| 413  | `http.payload_too_large`   | The body is over the route's limit (100 KB, or 256 KB for `/v1/ingest/events`), or has no declared length on the auth routes. |
| 500  | `internal.error`           | Unexpected failure. Details are logged, not returned.                                  |
