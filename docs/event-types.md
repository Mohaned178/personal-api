# Event types (v1)

This page describes the event envelope and the six browser event types accepted in v1. The
source of truth is `packages/contracts/src` (`envelope.ts`, `browser-events.ts`,
`registry.ts`). Every schema is strict: an unknown key is rejected, so titles, full URLs,
query strings, form contents and server-owned fields cannot ride along.

## Envelope

Each event in `POST /v1/ingest/events` has this shape:

| Field        | Type                     | Required | Notes                                                                                              |
| ------------ | ------------------------ | -------- | -------------------------------------------------------------------------------------------------- |
| `id`         | UUID (RFC 9562)          | yes      | Client-generated, used for dedupe. Lowercased on input. Max 36 characters.                          |
| `type`       | string                   | yes      | 1 to 128 characters, for example `browser.page_visited`.                                           |
| `typeVersion`| integer ≥ 1              | yes      | Must be a registered version of `type` (v1 types use `1`).                                          |
| `occurredAt` | UTC ISO 8601 date-time   | yes      | Must end in `Z`, for example `2026-10-13T10:00:00.000Z`. Real dates only.                           |
| `data`       | object                   | yes      | Checked against the schema of `type@typeVersion`.                                                  |
| `meta`       | object                   | no       | `{ "ruleSetVersion": <int ≥ 0>, "client": <string 1–100 chars> }`. Strict.                         |

The server sets `userId`, `integrationId`, `receivedAt` and `origin` from the API key. Sending
any of them in the envelope or in `data` makes the event invalid (`ingest.envelope_invalid` or
`ingest.payload_invalid`).

An event that fails validation gets a per-item `rejected` result with one of the codes listed in
[api.md](./api.md#error-codes). Rejected events are never stored; only counters are kept.

## Privacy rules for browser events

These rules are enforced by the contracts, not only by the extension:

- **Domain and path only.** `domain` is a lowercase ASCII hostname (IDNs in punycode). `path`
  starts with `/`.
- **No query string or fragment.** `path` containing `?` or `#` is rejected. The extension
  strips both before building an event, unless a `keep_query` rule matches (M4).
- **No titles, form contents, keystrokes, passwords or full URLs.** Any such key is an unknown
  key and the event is rejected.
- **No incognito tabs.** The extension never sends them.
- **Random tab references.** `tabRef` is a per-browser-session random string of 8 to 64
  URL-safe characters (`[A-Za-z0-9_-]`). It is never the Chrome tab id.

Shared field types:

- `domain`: lowercase ASCII hostname, at most 253 characters, no scheme, port, userinfo, path or
  trailing dot.
- `path`: starts with `/`, at most 2048 characters, no `?`, `#`, control characters or lone
  surrogates.
- `tabRef`: 8 to 64 characters from `[A-Za-z0-9_-]`.
- Timestamps (`startedAt`, `endedAt`): UTC ISO 8601 with a `Z` suffix.

## Types

### `browser.page_visited` (v1)

A page navigation the browser reported.

| Field        | Type    | Required | Notes                                                                      |
| ------------ | ------- | -------- | -------------------------------------------------------------------------- |
| `domain`     | domain  | yes      |                                                                            |
| `path`       | path    | yes      |                                                                            |
| `transition` | enum    | no       | One of `link`, `typed`, `auto_bookmark`, `auto_subframe`, `manual_subframe`, `generated`, `auto_toplevel`, `start_page`, `form_submit`, `reload`, `keyword`, `keyword_generated`. |
| `tabRef`     | tabRef  | yes      |                                                                            |

```json
{
  "id": "0190f5a8-7c1e-7a2b-9d3f-4b5c6d7e8f90",
  "type": "browser.page_visited",
  "typeVersion": 1,
  "occurredAt": "2026-10-13T10:00:00.000Z",
  "data": { "domain": "example.com", "path": "/docs/start", "transition": "link", "tabRef": "k3j2h1g4f5d6a7b8" }
}
```

### `browser.focus_segment` (v1)

A span during which a tab was focused and the browser was active.

| Field        | Type    | Required | Notes                                                                                     |
| ------------ | ------- | -------- | ----------------------------------------------------------------------------------------- |
| `domain`     | domain  | yes      |                                                                                           |
| `path`       | path    | yes      |                                                                                           |
| `startedAt`  | UTC timestamp | yes |                                                                                           |
| `endedAt`    | UTC timestamp | yes | Not before `startedAt`.                                                                    |
| `durationMs` | integer | yes      | `0` to `1800000` (30 minutes, inclusive). Must equal `endedAt − startedAt` exactly.        |

Segments longer than 30 minutes are rejected as runaway durations.

### `browser.tab_opened` (v1)

| Field    | Type   | Required | Notes                    |
| -------- | ------ | -------- | ------------------------ |
| `tabRef` | tabRef | yes      |                          |
| `domain` | domain | no       | Omitted when unknown.    |

### `browser.tab_closed` (v1)

| Field    | Type   | Required | Notes                    |
| -------- | ------ | -------- | ------------------------ |
| `tabRef` | tabRef | yes      |                          |
| `domain` | domain | no       | Omitted when unknown.    |

### `browser.session_started` (v1)

| Field    | Type | Required | Notes                                                                 |
| -------- | ---- | -------- | --------------------------------------------------------------------- |
| `reason` | enum | yes      | `startup` (browser started) or `resume` (the worker found a session already running after a restart). |

### `browser.session_ended` (v1)

| Field    | Type | Required | Notes                                                                                                   |
| -------- | ---- | -------- | ------------------------------------------------------------------------------------------------------- |
| `reason` | enum | yes      | `idle`, `lock`, `shutdown`, or `recovered` (the session was closed after the fact, for example after a crash). |

## Versioning

A new shape for an existing type is a new `typeVersion`, registered alongside the old one in
`eventTypeRegistry` (`packages/contracts/src/registry.ts`). An unregistered version is rejected
with `ingest.type_version_unknown`.
