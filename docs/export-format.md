# Export format

A data export is a copy of your stored events, written as two files. You create one from the
dashboard or with the session API, then download both files. This page describes those files.
The schemas it refers to live in `packages/contracts/src/exports.ts`.

Exports need a dashboard session. Keys (`pa_ing_` or `pa_read_`) cannot create or download them.

## Creating an export

```bash
curl -s -X POST "$BASE/v1/exports" \
  -H "Origin: $BASE" \
  -H "Content-Type: application/json" \
  -b "$JAR" \
  -d '{"filter":{"source":"01a13ab2-9115-7297-97ce-f317f4310b8e","from":"2026-10-01T00:00:00.000Z"}}'
```

`POST /v1/exports` answers `202` with the export in status `queued`. The work runs in a background
job, so poll `GET /v1/exports/:id` until `status` is `completed` or `failed`.

The body is optional. An empty body (or `{}`) exports everything you have. `filter` takes the
same fields as the events list, and nothing else (unknown keys are rejected with 400):

| Field    | Meaning                                                   |
| -------- | --------------------------------------------------------- |
| `source` | an integration id; only events from that integration     |
| `type`   | an event type name, for example `browser.page_visited`    |
| `from`   | ISO 8601 timestamp; events with `occurredAt` at or after it |
| `to`     | ISO 8601 timestamp; events with `occurredAt` strictly before it |
| `domain` | only events for this domain                               |

The user is always your session's user. The body cannot name another user.

### The export object

```json
{
  "export": {
    "id": "01a1f0c4-6b2e-7d10-9a7e-2f1d3c4b5a69",
    "status": "completed",
    "filter": { "source": "01a13ab2-9115-7297-97ce-f317f4310b8e" },
    "eventCount": 1284,
    "sizeBytes": 48211,
    "createdAt": "2026-10-20T09:12:04.118Z",
    "finishedAt": "2026-10-20T09:12:05.901Z",
    "expiresAt": "2026-10-21T09:12:05.901Z"
  }
}
```

`status` is one of `queued`, `running`, `completed` or `failed`. `eventCount`, `sizeBytes`,
`finishedAt` and `expiresAt` are `null` until the job has finished. `GET /v1/exports` lists your
50 most recent exports.

## The two files

A completed export has two files. Download both:

| File                 | Route                          | Content type       |
| -------------------- | ------------------------------ | ------------------ |
| `events.ndjson.gz`   | `GET /v1/exports/:id/download` | `application/gzip` |
| `manifest.json`      | `GET /v1/exports/:id/manifest` | `application/json` |

Both responses are sent as attachments with `Cache-Control: no-store`.

### `events.ndjson.gz`

The file is gzip-compressed NDJSON: one JSON object per line, UTF-8, `\n` between lines. Once
decompressed, each line is a stored event:

```json
{"id":"01a1f0c4-7d10-7c2a-8e51-0b9f6d3a2c11","integrationId":"01a13ab2-9115-7297-97ce-f317f4310b8e","type":"browser.page_visited","typeVersion":1,"occurredAt":"2026-10-20T08:57:31.000Z","receivedAt":"2026-10-20T08:57:32.418Z","origin":"collected","data":{"domain":"example.com","path":"/docs/getting-started","…":"the rest of the type's fields, shown in full in the file"},"tags":["reading"],"trace":null}
```

The `data` above is abbreviated for this page. In the file it has every field its type's schema
defines.

| Field           | Meaning                                                                                 |
| --------------- | --------------------------------------------------------------------------------------- |
| `id`            | the event's UUIDv7                                                                      |
| `integrationId` | the integration (source) that sent the event                                            |
| `type`          | the event type, without the version                                                     |
| `typeVersion`   | the version of the type's schema that `data` follows                                    |
| `occurredAt`    | when the event happened, as the source reported it (ISO 8601, UTC)                      |
| `receivedAt`    | when the server accepted it (ISO 8601, UTC)                                             |
| `origin`        | `collected`, `imported` or `derived`                                                    |
| `data`          | the event's payload, shaped by its type's schema (see [event types](event-types.md))    |
| `tags`          | tags that rules added to the event                                                      |
| `trace`         | the rule decisions made for this event, or `null` when there is no trace the server can read |

Lines are ordered newest first by `(occurredAt, id)`. The export never contains dropped events:
they were never stored (see [data lifecycle](data-lifecycle.md)).

Every line has the shape of the `storedEventSchema` in `packages/contracts`. Validate it with that
schema, or with a JSON Schema generated from it, if you process the file with other tools.

### `manifest.json`

The manifest describes the events file. Check it before you trust the events file: the hash and
byte count let you confirm you have the whole file, unchanged.

```json
{
  "format": "personal-api-export",
  "formatVersion": 1,
  "exportId": "01a1f0c4-6b2e-7d10-9a7e-2f1d3c4b5a69",
  "generatedAt": "2026-10-20T09:12:05.901Z",
  "filter": { "source": "01a13ab2-9115-7297-97ce-f317f4310b8e" },
  "eventCount": 1284,
  "file": {
    "name": "events.ndjson.gz",
    "sha256": "3f1c9a0e7b52d4c86e19f0a3b7d2e5c48a61f9d0b3e27c5a8d4f1e60b2c7a93d",
    "bytes": 48211
  }
}
```

| Field           | Meaning                                                                           |
| --------------- | --------------------------------------------------------------------------------- |
| `format`        | always `personal-api-export`                                                      |
| `formatVersion` | the version of this layout; `1` today                                             |
| `exportId`      | the export this file belongs to                                                   |
| `generatedAt`   | when the events file was finished (ISO 8601, UTC)                                 |
| `filter`        | the filter the export was created with (`{}` for an export of everything)         |
| `eventCount`    | how many lines `events.ndjson.gz` holds                                           |
| `file.name`     | always `events.ndjson.gz`                                                         |
| `file.sha256`   | hex SHA-256 of the **gzip file's bytes** (not of the decompressed lines)          |
| `file.bytes`    | size of the gzip file in bytes                                                    |

To check a download, compute the SHA-256 and byte count of the `.gz` file you received and compare
them with `file`. Then count the lines after decompressing; the count must equal `eventCount`.

```bash
sha256sum events.ndjson.gz          # must match file.sha256
stat -c %s events.ndjson.gz         # must match file.bytes
gunzip -c events.ndjson.gz | wc -l  # must match eventCount
```

## Download window and errors

A completed export can be downloaded for 24 hours (`expiresAt`). After that the API removes both
files and the export row, on the hourly cleanup run (see [data lifecycle](data-lifecycle.md)).

| Status | Code                  | When                                                                 |
| ------ | --------------------- | -------------------------------------------------------------------- |
| 404    | `export.not_found`    | no export with that id belongs to your account                       |
| 409    | `export.not_ready`    | the export is still `queued` or `running`, or it `failed`, so no file |
| 410    | `export.expired`      | the download window has closed, or the file is no longer on the server |

Errors are RFC 9457 `application/problem+json` with the `code` above. A failed export can be
re-created; a new `POST` starts a new export.

Export files are removed when you delete your account, too.
