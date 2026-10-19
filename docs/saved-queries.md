# Saved queries

> **Status:** implemented. The schema, compiler and runner are M5-04; the endpoints that store and
> serve them (`/v1/endpoints`, `GET /v1/me/:slug`) are M5-05.

A saved query is what a user-defined endpoint runs. It picks events with the **same `when` as a
rule** (see `rule-format.md`), inside a relative time window, and returns **either** a projection of
raw events **or** an aggregate. The schema is `savedQueryDefinitionSchema` in
`packages/contracts/src/saved-query.ts`. Every object is strict: an unknown key is an error.

```json
{
  "when": {
    "source": ["browser-extension"],
    "type": ["browser.page_visited"],
    "none": [{ "field": "data.path", "op": "starts_with", "value": "/settings" }]
  },
  "window": { "kind": "last_n_days", "days": 7 },
  "fields": ["occurredAt", "data.domain"],
  "limit": 200
}
```

| Key         | Notes                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------- |
| `when`      | Required (may be `{}`). Validated exactly as a rule's `when`, by the same function.          |
| `window`    | Required. There is no unbounded query. See [Windows](#windows).                              |
| `fields`    | Raw events: 1 or more of the [allowed fields](#projection). Unique.                          |
| `aggregate` | `count_by_day`, `count_by_domain` or `duration_by_domain`.                                   |
| `limit`     | 1 to 1,000. Default 100.                                                                     |

**Exactly one of `fields` and `aggregate`.** That is the aggregate-only guarantee: a definition with an
`aggregate` has no projection, and the compiled query has no field list at all, so it cannot return
a raw event. A definition with neither is rejected too (nothing says what to return).

## Windows

Cut in the user's time zone (`GET /v1/settings`), computed by Postgres from a bound `now`, so
daylight saving is right (the day a zone turns the clocks back has 25 hours).

| Kind          | Covers                                                                   |
| ------------- | ------------------------------------------------------------------------ |
| `today`       | Local midnight to the next local midnight.                               |
| `this_week`   | Monday 00:00 local to the next Monday 00:00.                             |
| `last_n_days` | `days` (1 to 90) calendar days, ending at the end of today.              |

## Projection

`type`, `occurredAt`, and the `data.*` fields that rule conditions may use (`data.domain`,
`data.path`, `data.transition`, `data.startedAt`, `data.endedAt`, `data.durationMs`, `data.reason`).
Never the event id, tags, trace, `tabRef`, receive time or integration. Each field must exist on one
of the types `when` selects. In a result row the key is the field name without `data.`
(`data.domain` → `domain`). A field the event's type lacks is `null`. Rows are newest first.

## Aggregates

| Aggregate            | Row                          | Counts                                                                                   |
| -------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| `count_by_day`       | `{ date, count }`            | Selected events per local day, oldest first.                                             |
| `count_by_domain`    | `{ domain, count }`          | Selected events per domain (events with no domain are skipped), most first, then name.   |
| `duration_by_domain` | `{ domain, activeMs }`       | Sum of `browser.focus_segment` durations, each clamped to 30 minutes, most first.        |

`count_by_domain` needs a selected type that has a domain; `duration_by_domain` needs
`browser.focus_segment` among them, and counts only those events.

## Result

`{ "kind": "events" | <aggregate>, "rows": [...], "truncated": boolean }` (`savedQueryResultSchema`).
`truncated` is true when more rows matched than `limit`.

## Limits and safety

- **1,000 rows** at most and a **2-second `statement_timeout`**, for every query, aggregates
  included. A run is one read-only transaction; the timeout is set with `set_config(..., true)`, so
  it ends with the transaction and never leaks to another query on the pool. A timeout is
  `504 saved_query.timeout`.
- Values and JSON keys are **bound parameters**; a field name picks from a closed list and is never
  an identifier. There is no regex, no code and no string SQL (invariants 7 and 8). `matches_glob`
  becomes `LIKE` with `%`, `_` and `\` escaped, so they stay literal as in the engine.
- The definition is parsed **again** at run time, because it comes out of a jsonb column. One that
  does not parse is `409 saved_query.definition_invalid`; a filter is never skipped.
- Every condition has the engine's semantics, pinned by a parity test against `evaluate()`: a
  condition on a missing field is false (so a `none` on it holds), except `exists: false`.
- The query runs for the endpoint owner's `userId` through `scopeCondition`; the `source` filter
  looks only at that user's integrations.

## Endpoints

An endpoint is a slug plus a saved query (`endpointInputSchema` in `packages/contracts/src/endpoints.ts`).
Slugs are 1 to 40 lowercase letters, digits and inner hyphens, unique per user; a user has at most 50
endpoints.

| Route                                  | Auth    | Does                                                                                   |
| -------------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| `POST /v1/endpoints`                   | session | Creates the endpoint and its key. Answers `{ endpoint, key }`; the key is shown once.  |
| `GET /v1/endpoints`, `GET /:id`        | session | List (by slug) and read. Never a key.                                                  |
| `PUT /v1/endpoints/:id`                | session | Replaces slug, `enabled` and definition. The key keeps working.                        |
| `DELETE /v1/endpoints/:id`             | session | Deletes the endpoint and its keys.                                                     |
| `POST /v1/endpoints/:id/rotate-key`    | session | Revokes the endpoint's keys, answers `{ endpoint, key }` with a new one.               |
| `POST /v1/endpoints/preview`           | session | Runs an unsaved `{ definition }` with the same limits. Stores nothing.                 |
| `GET /v1/me/:slug`                     | read key| Runs the endpoint. The key must carry `endpoint:<id>` of the endpoint the slug names.  |

The key is a read key (`pa_read_`) with the single scope `endpoint:<id>`, stored with `endpoint_id`. It
cannot call `/v1/events`, `/v1/activity/*` or another endpoint, and a general read key
(`events:read`, `activity:read`) cannot run an endpoint. The slug is looked up among the **key
owner's** endpoints. An unknown, malformed or disabled endpoint is `404 endpoint.not_found`; a key
without the endpoint's scope is `403 auth.insufficient_scope`. The key also shows in `GET /v1/keys`,
where it can be revoked (rotate to get a working one again).
