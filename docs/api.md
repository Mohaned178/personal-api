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
signed-in user; the body cannot name a user. `kind: "http"` gets its ingest key in this response.
`kind: "browser-extension"` gets no key here; see [Browser-extension integrations](#browser-extension-integrations).
New integrations start with `defaultPolicy: "deny"`.

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

### Browser-extension integrations

The extension normally connects with one click: the popup opens the dashboard's
`/connect-extension` page, and the **Connect this browser** button runs steps 1 and 2 below with the
user's session, then hands the code to the extension in the URL fragment of
`/connect-extension/done` (the fragment never reaches the server). The extension redeems it with
step 3. No new API route is involved; see [ADR 0003](adr/0003-one-click-connect.md). An integration
can also be created and paired by hand. Pairing hands it its ingest key once:

```bash
# 1. Create the integration (no key yet)
curl -s -X POST "$BASE/v1/integrations" -H "Content-Type: application/json" -b "$JAR" \
  -d '{"kind":"browser-extension","name":"Firefox laptop"}'

# 2. A 10-minute pairing code for it (session cookie). Issuing a new code invalidates the old one.
curl -s -X POST "$BASE/v1/integrations/<integration-id>/pairing-code" -b "$JAR"
# 201 {"pairingCode":"GBQH-71ED-NXVT-J45S-JYD9","expiresAt":"…"}

# 3. The extension redeems the code once. No cookie or key: the code is the credential.
curl -s -X POST "$BASE/v1/pair" -H "Content-Type: application/json" \
  -d '{"pairingCode":"GBQH-71ED-NXVT-J45S-JYD9"}'
# 200 {"integration":{…},"ingestKey":{"id":"…","key":"pa_ing_…","prefix":"pa_ing_…"}}
```

The ingest key in step 3 is shown once (`Cache-Control: no-store`). A redeemed or expired code
is `400 pairing.code_invalid`. Only an active browser-extension integration can be paired
(`409 pairing.integration_not_pairable`). `POST /v1/pair` allows 10 attempts a minute per client
address (`429 pairing.rate_limited`). The extension then reads its rules with
`GET /v1/ingest/config` (section 4).

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

A new integration has `defaultPolicy: "deny"` and no rules. Until a rule allows `example.com`
(create one in [section 6](#6-rules-dashboard)), the first event comes back `dropped`, not
`accepted`. Once that rule exists, the response is `200` with one result per event, in request order:

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
version, the integration's default policy, your daily site limits (`limits`, see section 7), your running
focus session (`focus`, or `null`) and enabled schedules (`schedules`),
with a strong `ETag` that changes when any of them does. Only the key of a
`browser-extension` integration may call it: an `http` integration's key gets
`403 ingest.config_unsupported`, because only an extension applies rules itself. The browser extension polls it
with `If-None-Match`; a match is `304` with no body. The format and the extension's behaviour are
in [rule-format.md](rule-format.md#extension-sync-m4-06).

```bash
# $EXT_KEY: the ingest key of a browser-extension integration (the extension gets it when it pairs)
curl -s "$BASE/v1/ingest/config" -H "Authorization: Bearer $EXT_KEY"
# {"ruleSetVersion":0,"defaultPolicy":"deny","rules":[],"limits":[],"focus":null,"schedules":[]}
# With $KEY from the `http` integration above: 403 {"code":"ingest.config_unsupported", ...}
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
- **Validation** is the contracts' `ruleSaveSchema`: `ruleDefinitionSchema`, the one the engine and the
  extension use, minus the actions reserved for v1.1. `forward` and `keep_query` are refused on create,
  replace and dry run. `400 request.invalid` lists `issues` (path and fixed message, never the rule's values).

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

## 7. Read your data

Read routes take the dashboard session cookie (`-b "$JAR"`, from the sign-in step) and nothing else:
no API key reads data. The only API key is the ingest key, which can only ingest. Read keys
(`pa_read_`) and saved-query endpoints (`/v1/endpoints`, `/v1/me/<slug>`) were removed in v1.1; those
paths answer `404`, and a `pa_read_` key in an `Authorization` header is ignored.

### Events

```bash
curl -s "$BASE/v1/events?limit=5" -b "$JAR"
```

Filters: `source` (integration id), `type`, `from`, `to`, `domain`. `limit` is 1 to 200 (default
50). Pass the previous page's `nextCursor` as `cursor`; it is opaque and paged on
`(occurredAt, id)`, so offsets are not used. `GET /v1/events/<id>` (one event) and
`DELETE /v1/events` also take the session cookie (see [Delete data](#delete-data)).

Each event carries `origin` (`collected`), `tags`, and `trace` (why it was kept; `null` for events
stored before rules existed). The payload is in `data`.

### Activity

```bash
curl -s "$BASE/v1/activity/daily?from=2026-10-01T00:00:00.000Z&to=2026-10-31T00:00:00.000Z" \
  -b "$JAR"
curl -s "$BASE/v1/activity/domains?from=2026-10-01T00:00:00.000Z&to=2026-10-31T00:00:00.000Z&limit=5" \
  -b "$JAR"
```

`from` must be before `to`, at most 90 days apart (`400 activity.range_invalid` otherwise). When
both are omitted the range is the last 7 days. `daily` answers with `timeZone` (the user's setting)
and one entry per local day that has activity, with `activeMs` and `pageVisits`. `domains` takes
`limit` up to 100. Time comes from focus segments; a day with page visits and no focus time shows
`activeMs: 0`.

Three more routes feed the dashboard's site page and Patterns page (M9-03), with the same `from`/`to`
rules, and days and hours cut in your time zone:

```bash
curl -s "$BASE/v1/activity/site?domain=example.com" -b "$JAR"
curl -s "$BASE/v1/activity/hours" -b "$JAR"
curl -s "$BASE/v1/activity/sessions?limit=50" -b "$JAR"
```

- `site` needs `domain` (a lowercase hostname). It answers with `days`, `activeMs`, `pageVisits`,
  `sessions` (focus segments), `averageSessionMs`, `longestSessionMs` and the 10 busiest `paths`.
- `hours` answers with `cells` of `{weekday, hour, activeMs}` (`weekday` 0 is Monday), only for hours
  that have activity.
- `sessions` lists focus segments newest first (`id`, `domain`, `startedAt`, `endedAt`,
  `durationMs`). `limit` is 1 to 200 (default 50). Pass `nextCursor` as `cursor`; a cursor this API
  did not issue is `400 activity.cursor_invalid`.

### Recommendations

`GET /v1/recommendations` (session only, no query) suggests changes from your own last 4 weeks,
with fixed rules and no outside service. It answers with `from`, `to`, `timeZone` and at most 6
`recommendations`, each with a `kind`:

- `limit_plan`: a heavy site (about 45 minutes or more a day on at least 10 of the days, and no
  limit on it yet) with `averageMinutes` and `steps` (2 to 4 daily limits, 15 minutes apart, down a
  third, never under 30). Applying it is `POST /v1/limits` with the first step.
- `limit_step`: a limit you kept for the last week (5 or more active days, none over it): the
  `nextMinutes` is 15 less, never under 30. Applying it is `PUT /v1/limits/:id`.
- `late_night`: most of the time on a site (`sharePercent`) falls between `fromHour` and `toHour`
  (23:00 to 07:00 in your time zone). Applying it is `POST /v1/schedules` with a schedule for
  those hours on every day (M9-06).

With less than 14 days of data the list is empty. Dismissals are kept in the browser, not the API.

### Time zone

Days are cut in your time zone, which is a setting. Like every route here they take the session
cookie only (a bearer key gets `401 auth.unauthenticated`).

```bash
curl -s "$BASE/v1/settings" -b "$JAR"                          # { "timeZone": "UTC" }
curl -s "$BASE/v1/settings/time-zones" -b "$JAR"               # { "timeZones": ["Africa/Abidjan", ...] }
curl -s -X PATCH "$BASE/v1/settings" -b "$JAR" -H "Content-Type: application/json" \
  -d '{"timeZone":"Europe/Berlin"}'
```

`time-zones` lists the names the **database** accepts, sorted. That is not the same list as your
browser's: the Postgres image has no legacy link names such as `Asia/Calcutta` (use `Asia/Kolkata`),
and such a name is `400 settings.time_zone_unsupported`. A zone that was saved earlier and no
longer works makes `/v1/activity/daily` answer `409 settings.time_zone_unsupported`
until you choose another one.

### Retention

Every stored event gets an `expires_at` (`receivedAt` plus its retention days). The days come from
the first of: a `set_retention` rule, the policy for the event's **type**, the policy for its
**source** (the integration id), then the default of 90 days.

Two jobs in the worker (`pnpm worker`) act on that date:

- **Purge**, every hour on the hour (UTC): deletes events whose `expires_at` has passed, in batches
  of 1 000 (at most 200 000 per run; the next run carries on). Events stored before retention
  existed had no `expires_at`; a migration gave them `received_at` plus 90 days, so they are purged
  like the rest.
- **Recompute**, about a minute after you change or delete a policy: sets `expires_at` to
  `received_at` plus the days the policies now give, for your stored events, so a policy applies to
  past events too. Events a `set_retention` rule governs keep the date the rule gave. Lowering a
  policy can put old events past their date, and the next purge deletes them for good; raising one
  brings back only events that have not been purged yet.

```bash
curl -s "$BASE/v1/retention" -b "$JAR"                        # { "defaultDays": 90, "policies": [...] }
curl -s -X PUT "$BASE/v1/retention/type/browser.page_visited" -b "$JAR"   -H "Content-Type: application/json" -d '{"days":30}'        # a policy for one event type
curl -s -X PUT "$BASE/v1/retention/source/$INTEGRATION_ID" -b "$JAR"   -H "Content-Type: application/json" -d '{"days":14}'        # a policy for one integration
curl -s -X DELETE "$BASE/v1/retention/type/browser.page_visited" -b "$JAR"   # 204
```

`days` is a whole number from 1 to 3650. An event whose `occurredAt` is older than its own
retention is rejected with `ingest.occurred_at_too_old`.

### Daily site limits

A limit is a domain pattern plus minutes per day: `youtube.com` is that site only, `*.youtube.com`
its subdomains (not the apex). The browser extension gets your limits with its rules and enforces
them on the device: a notification with 10 minutes left, a notification and a "Time's up" page at the
limit, and "5 more minutes" unless the limit is `strict`. Everything resets at your local midnight.
A limit counts only time on sites your rules collect. The server stores the limits and nothing else:
it never sees how much time you used.

```bash
curl -s "$BASE/v1/limits" -b "$JAR"                       # { "limits": [ { "id", "pattern", "minutes", "strict" } ] }
curl -s -X POST "$BASE/v1/limits" -b "$JAR" -H "Content-Type: application/json"   -d '{"pattern":"youtube.com","minutes":60}'              # 201, the limit with its id
curl -s -X PUT "$BASE/v1/limits/$LIMIT_ID" -b "$JAR" -H "Content-Type: application/json"   -d '{"pattern":"youtube.com","minutes":45,"strict":true}' # replaces the whole limit
curl -s -X DELETE "$BASE/v1/limits/$LIMIT_ID" -b "$JAR"     # 204
```

`minutes` is a whole number from 1 to 1440, `strict` defaults to `false`. A body with `id` or
`userId` is a `400`. You can have one limit per pattern and up to 50 limits.

### Focus mode and schedules

Both block sites on the device. The browser extension gets them with its rules and your limits (a
change reaches it within about a minute) and moves a tab on a blocked site to a "Time's up" page that
says why and until when. There is no "more minutes" button. A site is blocked while any block covers
it. `example.com` is that site only, `*.example.com` its subdomains (not the apex).

A focus session blocks sites for a number of minutes. You have at most one; starting another replaces
it. The end time is the server's clock plus `minutes`; a body with `endsAt`, `id` or `userId` is a
`400`.

```bash
curl -s "$BASE/v1/focus" -b "$JAR"                          # { "session": { "id", "patterns", "endsAt" } | null }
curl -s -X POST "$BASE/v1/focus" -b "$JAR" -H "Content-Type: application/json"   -d '{"patterns":["youtube.com","*.reddit.com"],"minutes":45}'   # 201, the session
curl -s -X DELETE "$BASE/v1/focus" -b "$JAR"                # 204, or 404 focus.not_found when none is running
```

`patterns` is 1 to 20 distinct sites and `minutes` a whole number from 1 to 480.

A schedule repeats: it blocks on the chosen `days` (0 is Monday, 6 is Sunday) from `start` to `end`
(`HH:MM`, 24 hours, in the clock of the device that enforces it). The start is included and the end is
not. An `end` earlier than `start` runs past midnight and its late part belongs to the day it started
on, so `23:00` to `07:00` on Friday is still on at 06:59 on Saturday. `start` and `end` cannot be
equal. A schedule with `enabled: false` is kept but never sent to the extension.

```bash
curl -s "$BASE/v1/schedules" -b "$JAR"                      # { "schedules": [ { "id", "name", "patterns", "days", "start", "end", "enabled" } ] }
curl -s -X POST "$BASE/v1/schedules" -b "$JAR" -H "Content-Type: application/json"   -d '{"name":"Work hours","patterns":["reddit.com"],"days":[0,1,2,3,4],"start":"09:00","end":"17:00"}'   # 201, with its id
curl -s -X PUT "$BASE/v1/schedules/$SCHEDULE_ID" -b "$JAR" -H "Content-Type: application/json"   -d '{"name":"Work hours","patterns":["reddit.com"],"days":[0,1,2,3,4],"start":"09:00","end":"18:00","enabled":false}'   # replaces the whole schedule
curl -s -X DELETE "$BASE/v1/schedules/$SCHEDULE_ID" -b "$JAR"   # 204
```

`name` is 1 to 60 characters, `patterns` 1 to 20 distinct sites. You can have up to 20 schedules.

### Categories, goals and the split

Every site is `productive`, `neutral` or `distracting` (M9-07). A built-in list covers well-known
sites (a site and its subdomains); everything else is neutral. Your own overrides beat the list.
The split is worked out when you ask for it, so an edit also changes the past. Nothing is written
onto events. Session only, like every route here.

```bash
curl -s "$BASE/v1/categories" -b "$JAR"                          # { "rules": [...], "presets": { "productive": [...], "distracting": [...] } }
curl -s -X POST "$BASE/v1/categories" -b "$JAR" -H "Content-Type: application/json" \
  -d '{"pattern":"*.example.com","category":"distracting"}'    # 201 { "id", "pattern", "category" }
curl -s -X PUT "$BASE/v1/categories/$ID" -b "$JAR" -H "Content-Type: application/json" \
  -d '{"pattern":"*.example.com","category":"neutral"}'        # replaces the override
curl -s -X DELETE "$BASE/v1/categories/$ID" -b "$JAR"           # 204
curl -s "$BASE/v1/activity/categories" -b "$JAR"                # { "days": [{ "date", "productiveMs", "neutralMs", "distractingMs" }] }
```

- A pattern is `example.com` (that site) or `*.example.com` (its subdomains). An exact pattern beats
  a wildcard, and a longer wildcard beats a shorter one. One override per pattern
  (`409 category.pattern_taken`), at most 200 per user (`409 category.limit_reached`). A foreign,
  unknown or malformed id is `404 category.not_found`.
- `activity/categories` takes the same `from`/`to` as the other activity routes. Days are cut in your
  time zone and days without activity are left out. The split covers the 100 busiest sites of the
  range; time on any other site counts as neutral.
- A goal is a daily ceiling on `distracting` or `neutral` time, one per category:
  `GET /v1/goals`, `PUT /v1/goals/:category` with `{"minutes": 60}` (1 to 1440, creates or replaces),
  `DELETE /v1/goals/:category` (204). Any other category, or a goal that is not set, is
  `404 goal.not_found`. The streak and the weekly summary are worked out in the dashboard from
  `activity/categories`, `activity/domains` and `activity/site`.

### Delete data

Deletion is a hard delete. Database backups keep deleted data until they rotate.

```bash
# By ids: deleted now, 200 {"deleted": n}. Ids that are not yours are not counted.
curl -s -X DELETE "$BASE/v1/events" -b "$JAR" -H "Content-Type: application/json" -d '{"ids":["<event-id>"]}'

# By filter: a job. 202 {"deletion": {...}}
curl -s -X DELETE "$BASE/v1/events" -b "$JAR" -H "Content-Type: application/json"   -d '{"filter":{"domain":"example.com","from":"2026-10-01T00:00:00.000Z"}}'
curl -s "$BASE/v1/events/deletions/<deletion-id>" -b "$JAR"   # progress

# Disconnect and delete everything one integration stored: revokes it (its key stops working at
# once), then starts the deletion. 202 {"integration": {...}, "deletion": {...}}
curl -s -X DELETE "$BASE/v1/integrations/$INTEGRATION_ID/data" -b "$JAR"
```

A filter takes the same fields as the list (`source`, `type`, `from` inclusive, `to` exclusive,
`domain`), and at least one is required; send `ids` or a `filter`, not both. A deletion has a
`status` (`queued`, `running`, `completed`, `failed`), `deleted` (events removed so far) and `total`
(events that matched when the job started, `null` before that; events that arrive during the run can
make `deleted` pass it). The worker (`pnpm worker`) runs it in batches of 1 000, and a failed job is
retried. An integration deletion starts about a minute after the request, so an ingest batch that
was already in flight when the key was revoked is swept up too. The integration stays in your list
as `revoked`; only its events are deleted. Its source retention policy is removed too, since it would
name a source with no data left. (Revoking alone keeps the policy, and the dashboard lists it as
revoked so you can still change or remove it.)

### Export your data

`POST /v1/exports` starts an export job (`202`, session cookie only). The optional `filter` takes the
same fields as the event list (`source`, `type`, `from`, `to`, `domain`); no filter exports everything. Poll
`GET /v1/exports/<id>` until `status` is `completed`, then download `GET /v1/exports/<id>/download`
(`events.ndjson.gz`: one stored event per line, newest first) and `GET /v1/exports/<id>/manifest`
(`manifest.json`: count, filter, and the size and SHA-256 of the gzip file). A completed export can be
downloaded for 24 hours, then the hourly cleanup job removes the files and the row.
`GET /v1/exports` lists your exports newest first, up to `limit` (1 to 50, default 50) per page; when
more remain it returns a `nextCursor` to pass back as `cursor` (`null` on the last page; a `cursor`
the API did not issue is `400 export.cursor_invalid`). Each user may have at most 3 exports queued or
running and has 10 exports created in any 24 hours; past either, `POST /v1/exports` answers
`429 export.limit_reached` and starts nothing. The worker writes the files to `EXPORT_DIR` (default
`data/exports`), which the API must see too. The directory and files are readable only by the user
that runs the worker.

```bash
curl -s -X POST "$BASE/v1/exports" -b "$JAR" -H "Content-Type: application/json" -d '{"filter":{"domain":"example.com"}}'
curl -s "$BASE/v1/exports/<export-id>" -b "$JAR"                          # progress
curl -s "$BASE/v1/exports/<export-id>/download" -b "$JAR" -o events.ndjson.gz
```

### Delete your account

`DELETE /v1/account` deletes your account and everything it owns: events, integrations, every
ingest key, rules, retention policies, deletion records, exports (files too), sessions
and queued jobs. It takes the session cookie only (no key can call it), and the account is the session's.

```bash
curl -s -i -X DELETE "$BASE/v1/account" -b "$JAR" -H "Content-Type: application/json" \
  -d '{"password":"<your password>","confirm":"delete my account"}'
```

The answer is `204` with no body, and the session cookies are expired. The request needs the
current password and the exact phrase `delete my account`. A wrong password is
`403 account.password_invalid` and deletes nothing; after 5 attempts in 15 minutes the account is
`429 account.rate_limited` with a `Retry-After` header (every attempt counts, right or wrong).
The deletion is one database transaction, so it either happens completely or not at all, and the
email can be used to sign up again afterwards. It is a hard delete: database backups keep the data
until they rotate.

## 8. OpenAPI

The API serves its OpenAPI document at `/docs` (a browsable UI), `/docs/json` and `/docs/yaml`.
It is public, because it describes request shapes only and holds no data. Request bodies and
query parameters come from the same Zod schemas the API validates with. The document does not yet
list response schemas or each route's auth, so the sections above remain the reference for those.

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
| `ingest.occurred_at_too_old`    | `occurredAt` is older than the event's retention (90 days by default, see Retention).   |
| `ingest.rule_error`             | Your rules could not be run on this event (a stored rule is invalid, or the engine failed). Nothing is stored. |

### Whole-request codes

| HTTP | Code                       | When                                                                                   |
| ---- | -------------------------- | -------------------------------------------------------------------------------------- |
| 400  | `ingest.batch_invalid`     | The batch has no `events` array, an empty one, more than 100 events, or an unknown top-level key. |
| 400  | `request.invalid`          | A request body fails validation (for example the heartbeat or an integration create).  |
| 401  | `auth.invalid_key`         | The Bearer ingest key is missing, malformed, unknown or revoked. |
| 401  | `auth.unauthenticated`     | A dashboard route was called without a valid session cookie.                           |
| 403  | `auth.signup_disabled`     | Sign-up is closed (`ALLOW_SIGNUP=false` and an account already exists).                 |
| 403  | `auth.csrf_origin_invalid` | A POST/PATCH/PUT/DELETE carrying a session cookie came from another origin (`Origin` is not `BETTER_AUTH_URL`'s). Nothing was done. |
| 403  | `account.password_invalid` | `DELETE /v1/account`: the password is wrong (or the account has no password to check). Nothing is deleted. |
| 429  | `account.rate_limited`     | `DELETE /v1/account`: 5 attempts in 15 minutes for this account. `Retry-After` says when to try again. |
| 429  | `ingest.rate_limited`      | More than 120 requests a minute with one ingest key (events, config and heartbeat together). `Retry-After` says when to try again. |
| 403  | `ingest.config_unsupported` | `GET /v1/ingest/config` only: the key belongs to an `http` integration, not a browser extension. |
| 400  | `pairing.code_invalid`     | `POST /v1/pair`: the code is unknown, expired, already redeemed or malformed.          |
| 409  | `pairing.integration_not_pairable` | `POST /v1/integrations/<id>/pairing-code`: the integration is not an active browser-extension integration. |
| 429  | `pairing.rate_limited`     | `POST /v1/pair`: more than 10 attempts a minute from one client address. `Retry-After` says when to try again. |
| 404  | `integration.not_found`    | The integration id is unknown, belongs to another user, or is malformed (all look the same). |
| 404  | `rule.not_found`           | The rule id is unknown, belongs to another user, or is malformed (all look the same). |
| 409  | `rule.limit_reached`       | The user already has 100 rules.                                                        |
| 404  | `limit.not_found`          | The limit id is unknown, belongs to another user, or is malformed (all look the same). |
| 409  | `limit.pattern_taken`      | `POST`/`PUT /v1/limits`: another limit of yours already has this pattern.              |
| 409  | `limit.limit_reached`      | `POST /v1/limits`: the user already has 50 limits.                                     |
| 404  | `focus.not_found`          | `DELETE /v1/focus`: there is no focus session to end.                                  |
| 404  | `schedule.not_found`       | The schedule id is unknown, belongs to another user, or is malformed (all look the same). |
| 409  | `schedule.limit_reached`   | `POST /v1/schedules`: the user already has 20 schedules.                               |
| 409  | `ingest.rule_error`        | `GET /v1/ingest/config` only: a stored rule is invalid, so no rules are sent.          |
| 413  | `http.payload_too_large`   | The body is over the route's limit (100 KB, or 256 KB for `/v1/ingest/events`), or has no declared length on the auth routes. |
| 400  | `activity.range_invalid`   | `from` is not before `to`, or the range is more than 90 days.                          |
| 400  | `events.cursor_invalid`    | The `cursor` is not one `nextCursor` returned.                                         |
| 404  | `deletion.not_found`       | `GET /v1/events/deletions/<id>`: the id is unknown, belongs to another user, or is malformed. |
| 404  | `export.not_found`         | An `/v1/exports/<id>` route: the id is unknown, belongs to another user, or is malformed. |
| 409  | `export.not_ready`         | `/download` or `/manifest` of an export that has not completed.                          |
| 410  | `export.expired`           | `/download` or `/manifest` after the 24-hour window, or the file is gone.                |
| 429  | `export.limit_reached`     | `POST /v1/exports`: 3 exports are already queued or running, or 10 were created in the last 24 hours. |
| 400  | `export.cursor_invalid`    | `GET /v1/exports`: the `cursor` is not one `nextCursor` returned.                      |
| 404  | `event.not_found`          | The event id is unknown, belongs to another user, or is malformed.                     |
| 400  | `settings.time_zone_unsupported` | `PATCH /v1/settings`: the database does not know this time zone (for example `Asia/Calcutta`). |
| 409  | `settings.time_zone_unsupported` | The time zone saved in your settings no longer works in a query (`/v1/activity/daily`). Choose another one. |
| 400  | `retention.target_invalid` | A retention route names an unknown scope, an unknown event type or a malformed integration id. |
| 404  | `retention.target_not_found` | `PUT`/`DELETE /v1/retention/...`: the integration is not yours or unknown, or there is no such policy to delete. |
| 500  | `internal.error`           | Unexpected failure. Details are logged, not returned.                                  |
