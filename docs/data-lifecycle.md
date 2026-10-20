# Data lifecycle

This page says where your data goes, how long it stays, and how you remove it. It covers what the
server stores and what it does not store. It is the reference for the self-hosted operator and for
anyone asking "what happens to my data".

## What is stored

- **Events you keep.** Each one is a row with its type, timestamps, origin, payload (`data`), tags
  and rule trace. See [export format](export-format.md) for the fields.
- **Dropped events are never stored.** When a rule drops an event, no payload is written
  anywhere. The server keeps only counters in `ingestion_log`: how many events each integration
  accepted, found duplicated, dropped or rejected, and per rule or error code. No payloads, URLs,
  domains or keys are in those counters.
- **Retention policies, integrations, keys and rules.** The configuration you set up.
- **Export files.** A finished export lives on disk for 24 hours (see below).
- **Bulk deletion progress.** A delete-by-filter job records its progress (counts and status),
  never the events it deleted.

The extension keeps only the domain and path of a page. Query strings and fragments are always
removed in v1 (the `keep_query` rule action is reserved for v1.1). Titles, form contents, keystrokes, passwords and incognito
tabs are never collected.

## How long events are kept

Every event gets an expiry, `expires_at`, when it is stored. It is the event's receive time plus
a number of days. The number comes from the first of these that applies:

1. a `set_retention` rule that matches the event;
2. the retention policy for its type;
3. the retention policy for its source (integration);
4. the default, **90 days**.

Set policies in the dashboard, or with the session API:

```bash
# A policy for one integration (scope "source"), or one event type (scope "type")
curl -s -X PUT "$BASE/v1/retention/source/01a13ab2-9115-7297-97ce-f317f4310b8e" \
  -H "Origin: $BASE" -H "Content-Type: application/json" -b "$JAR" \
  -d '{"days":30}'

curl -s -X DELETE "$BASE/v1/retention/type/browser.page_visited" -H "Origin: $BASE" -b "$JAR"
curl -s "$BASE/v1/retention" -b "$JAR"   # the default and every policy you have set
```

`days` is a whole number from 1 up to the ceiling the `set_retention` rule uses.

### When a policy changes

A change does not wait for events to be stored again. A background job, queued after a 60-second
delay, recomputes `expires_at` for your existing events from your current policies. The delay lets
an ingest batch that read the old policies finish first. Events a `set_retention` rule governs keep
their own value. Running the job again changes nothing more, so a repeat is harmless.

A change therefore reaches events you already have. Shortening a policy puts older events past
their date, and the next hourly purge deletes them for good; the dashboard asks you to confirm
before it saves a shorter value. Events stored before retention existed (they had no `expires_at`)
were given 90 days from receipt by a migration, so they follow the same rules.

### Purging

An hourly job, on the hour in UTC, deletes every event whose `expires_at` has passed. It works in
batches of 1,000, each in its own short transaction, so ingest is not held up. One run deletes at
most 200,000 events; the next hourly run continues if there are more. Overlapping runs are not a
problem.

## Deleting data yourself

Deletion is always a hard delete: the row is removed, not hidden.

| What                                  | How                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| Chosen events                         | `DELETE /v1/events` with `ids`; answers `200`                                           |
| Events matching a filter              | `DELETE /v1/events` with a filter; answers `202` with a job. Progress: `GET /v1/events/deletions/:id` |
| Everything one integration sent       | `DELETE /v1/integrations/:id/data` revokes the integration, then answers `202` with a job that deletes its events |
| Your whole account                    | `DELETE /v1/account` (see below)                                                        |

Revoking an integration (`POST /v1/integrations/:id/revoke`) stops its keys from working at once,
but it does **not** delete its data. `DELETE /v1/integrations/:id/data` does both: it revokes the
integration and deletes its events, along with its source retention policy.

### Deleting your account

`DELETE /v1/account` needs your current password and the body field `confirm` set to
`delete my account`. It answers `204` and clears your session cookies. Every row you own is
removed in one transaction, including events, integrations, keys, sessions, rules, retention
policies, saved-query endpoints, deletion jobs and exports. A completeness test checks that no
table is missed. Export files on disk are removed first, before that transaction. A
missing file is fine, so the step can be re-run. Wrong passwords get `403 account.password_invalid`.
Repeated attempts are rate limited (`429 account.rate_limited`).

## Exports

A completed export is downloadable for **24 hours**. An hourly cleanup job, at minute 30 past
the hour in UTC, then removes the export's files and its row. The job also removes export folders
that no row owns, such as the leftovers of an account deleted during an export run. An export that
failed, or never finished, is removed once it is 24 hours old. If the account is deleted while an
export job is writing, the job removes its own files when it finds the export row gone.

To keep a runaway client from filling the disk, a user can have at most 3 exports queued or running
and can start at most 10 in any 24 hours (`429 export.limit_reached`). The export directory and its
files are readable only by the user that runs the worker.

## Backups

Deletion removes data from the live database, but **database backups keep deleted data until
those backups rotate or are destroyed.** A deleted event can therefore still exist in an older
backup. If that matters to you, set a backup retention that fits your needs and keep backups as
private as the live database. Self-hosting notes live in [self-hosting](self-hosting.md).

## Summary

| Data                          | Kept until                                                       |
| ----------------------------- | ---------------------------------------------------------------- |
| Events                        | their `expires_at` (default 90 days after receipt), then purged hourly |
| Dropped-event counters        | until the account is deleted; they hold no payloads               |
| Export files                  | 24 hours after the export completes                              |
| Anything you delete           | removed at once from the live database; old backups keep it until they rotate |
