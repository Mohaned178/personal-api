# Rule format (draft)

> **Status:** draft from M4-01. The schema is real (`packages/contracts/src/rules.ts`,
> `rule-fields.ts`, `rule-glob.ts`) and is what the API will validate on save. The evaluation
> section is what the engine (M4-02) will implement. Items marked ⚑ go beyond PLAN §5 and need
> the owner's yes before M4-02 builds on them.

A rule says which events it applies to (`when`) and what to do with them (`then`). Users edit it
in the dashboard form or as JSON. The same document is stored, sent to the extension and run by
the engine on both sides, so a rule means the same thing everywhere.

```json
{
  "name": "Track GitHub, but not settings pages",
  "enabled": true,
  "priority": 10,
  "stage": "collect",
  "when": {
    "source": ["browser-extension"],
    "type": ["browser.*"],
    "all": [{ "field": "data.domain", "op": "domain_matches", "value": "github.com" }],
    "none": [{ "field": "data.path", "op": "starts_with", "value": "/settings" }]
  },
  "then": [{ "action": "allow" }]
}
```

## Document

Every object is strict: an unknown key is an error. A rule you submit has no `id` and no
`userId` (the server sets both). A stored rule, as the engine sees it, also has an `id` (UUID).

| Key        | Type                | Notes                                                                    |
| ---------- | ------------------- | ------------------------------------------------------------------------ |
| `name`     | string              | Trimmed, 1 to 100 characters.                                            |
| `enabled`  | boolean             | Required. A disabled rule is stored but never evaluated.                 |
| `priority` | integer 0 to 1000   | Required. **Lower numbers are evaluated first.** ⚑                        |
| `stage`    | `collect`/`process` | See [Stages](#stages).                                                   |
| `when`     | object              | Which events the rule applies to. May be `{}` (every event).             |
| `then`     | array of actions    | 1 to 10 actions, in the order they run.                                  |

## Stages

| Stage     | Runs                          | Actions                                                |
| --------- | ----------------------------- | ------------------------------------------------------ |
| `collect` | extension **and** server      | `allow`, `drop`, `redact`, `coarsen`, `keep_query`     |
| `process` | server only, after `collect`  | `tag`, `set_retention`                                 |

Saving a rule whose actions do not belong to its stage is an error. `process` rules cannot
decide: an event that `collect` kept stays kept.

## `when`

Every part that is present must hold (AND).

| Key      | Meaning                                                                                  |
| -------- | ---------------------------------------------------------------------------------------- |
| `source` | Any of `browser-extension`, `http` (the kind of integration that sent the event).        |
| `type`   | Any of these event-type patterns (1 to 20), for example `browser.*`. See [Globs](#globs). |
| `all`    | Every condition holds. 1 to 20 conditions.                                               |
| `any`    | At least one condition holds. 1 to 20.                                                   |
| `none`   | No condition holds. 1 to 20.                                                             |

The lists are flat: there is no nesting. An empty list is an error (not "always true" or
"always false"); leave the key out instead. An omitted `type` means every type.

### Conditions

`{ "field": "data.domain", "op": "eq", "value": "github.com" }`

Fields are named `data.<key>`. Which fields exist depends on the event type; see the
[field registry](#field-registry). A condition may only use an op that suits the field's kind:

| Op               | `value`                                  | Field kinds                         |
| ---------------- | ---------------------------------------- | ----------------------------------- |
| `eq`, `neq`      | string or number, matching the field     | domain, path, enum, int             |
| `in`             | 1 to 50 of the above                     | domain, path, enum                  |
| `starts_with`    | non-empty string                         | domain, path                        |
| `ends_with`      | non-empty string                         | domain, path                        |
| `contains`       | non-empty string                         | domain, path                        |
| `domain_matches` | `example.com` or `*.example.com`         | domain                              |
| `matches_glob`   | glob, see [Globs](#globs)                | domain, path                        |
| `gt`, `lt`       | number (int fields) or UTC date-time     | int, timestamp                      |
| `exists`         | `true` or `false`                        | every kind                          |

There is **no regex** and no way to run code (invariant 8). String values are 1 to 256
characters with no control characters. Comparisons are case-sensitive. Domains are lowercase
in events, so domain values must be lowercase too, and an uppercase one is rejected on save.

Value rules checked on save:

- `eq`/`neq`/`in` on a `domain` field need a valid lowercase hostname; on a `path` field, a
  valid path (starts with `/`, no `?` or `#`); on an `enum` field, one of its values; on an
  `int` field, an integer.
- `gt`/`lt` on a `timestamp` need a real UTC date-time ending in `Z`; on an `int` a number.
- `domain_matches` accepts an exact domain, or `*.` followed by a domain. The wildcard matches
  one or more labels to the left, so `*.example.com` matches `a.example.com` and
  `a.b.example.com` but **not** `example.com` itself. ⚑ Write both to cover the apex. A bare
  `example.com` does not match its subdomains.

### Globs

Used by `matches_glob` and by `when.type`. `*` matches any run of characters, including none
and including `/`. Every other character is literal (`?`, `[`, `.` and `(` have no special
meaning). At most 8 `*` per pattern. Case-sensitive. One function
(`globMatches`, in `contracts`) is used on both sides, and it is not regex-based, so it has no
ReDoS risk.

`when.type` patterns use only lowercase letters, digits, `_`, `.` and `*`, up to 128
characters. **Each pattern must match at least one registered event type**, so a typo such as
`browser.page_visted` is rejected on save instead of becoming a rule that never fires.

### Conditions on missing fields ⚑

A condition on a field the event does not have is **false** for every op, except `exists` with
`false`, which is true. Consequences:

- `type: ["browser.*"]` with a condition on `data.path` is fine: `tab_opened` has no path, so
  the condition is false there.
- A condition inside `none` on a missing field is satisfied, so a rule with only a `none`
  condition applies to every event that lacks the field. Prefer `all`/`any` for rules that
  `drop`, and put the `none` next to an `all` that already narrows the type.

The asymmetry to remember: a `drop` rule that fails to match lets the event through to the next
rule and finally to the default policy (deny for a new extension), while an `allow` rule that
fails to match only keeps something out. So the default stays safe either way.

## Actions

| Action          | Params                          | Stage     | Effect                                                                                      |
| --------------- | ------------------------------- | --------- | ------------------------------------------------------------------------------------------- |
| `allow`         | none                            | collect   | Terminal: collect the event.                                                                |
| `drop`          | none                            | collect   | Terminal: do not collect. Beats `allow` at the same priority.                               |
| `redact`        | `field`                         | collect   | Remove an **optional** field from `data`.                                                   |
| `coarsen`       | `segments` (0 to 10)            | collect   | Keep the first N segments of `data.path`. `0` leaves `/` (the path is required).           |
| `keep_query`    | none                            | collect   | Opt this match in to keeping the query string. ⚑ See [Open items](#open-items).             |
| `tag`           | `tag`                           | process   | Add a tag. Lowercase, starts with a letter or digit, then letters, digits, `_ . : -`, max 32. |
| `set_retention` | `days` (1 to 3650)              | process   | Keep the event this many days.                                                              |
| `forward`       | (reserved)                      | v1.1      | Webhook. The name is reserved: **a rule that uses it is rejected on save**, never ignored.  |

Checked on save:

- At most **one deciding action** (`allow` or `drop`) per rule, and no duplicate action in a
  rule (two `redact`s of different fields, or two different `tag`s, are fine).
- `redact`'s field must exist on a selected type and be optional on **every** selected type
  that has it. A required field (`domain` on `page_visited`) cannot be removed, because the
  event would no longer be valid. Narrow `type` (for example `browser.tab_*`) to redact it
  where it is optional.
- `coarsen` needs at least one selected type with a `data.path`.
- `redact`/`coarsen` leave a valid event: the engine must not produce one that
  `parseEvent()` would reject.

A rule with only transforms (no `allow`/`drop`) reshapes matching events but does not decide.

## Save-time validation

A rule is rejected (`400`, problem+json) if it:

- has an unknown key, a missing required key, or a value over a limit above;
- selects a `type` pattern that matches nothing;
- uses a field that none of the selected types has (an omitted `type` selects every type);
- uses an op the field's kind does not allow, or a value the field cannot hold (for several
  selected types: the op must suit every kind, and the value must fit at least one);
- puts an action in the wrong stage, or breaks the action rules above.

Error messages are fixed strings with a path, such as `when.all.0.field`. They never repeat the
rule's values (invariant 6): the values are domains and paths.

## Field registry

Source of truth: `ruleFieldRegistry` in `packages/contracts/src/rule-fields.ts`. A test fails if
an event data schema gains a field that is not listed here or in `NOT_CONDITIONABLE_FIELDS`.

| Type                       | Field              | Kind      | Optional | Values                                            |
| -------------------------- | ------------------ | --------- | -------- | ------------------------------------------------- |
| `browser.page_visited`     | `data.domain`      | domain    | no       |                                                   |
|                            | `data.path`        | path      | no       |                                                   |
|                            | `data.transition`  | enum      | **yes**  | `link`, `typed`, `reload`, … (see event-types.md) |
| `browser.focus_segment`    | `data.domain`      | domain    | no       |                                                   |
|                            | `data.path`        | path      | no       |                                                   |
|                            | `data.startedAt`   | timestamp | no       |                                                   |
|                            | `data.endedAt`     | timestamp | no       |                                                   |
|                            | `data.durationMs`  | int       | no       |                                                   |
| `browser.tab_opened`       | `data.domain`      | domain    | **yes**  |                                                   |
| `browser.tab_closed`       | `data.domain`      | domain    | **yes**  |                                                   |
| `browser.session_started`  | `data.reason`      | enum      | no       | `startup`, `resume`                               |
| `browser.session_ended`    | `data.reason`      | enum      | no       | `idle`, `lock`, `shutdown`, `recovered`           |

`data.tabRef` is not available to conditions: it is a random per-session id with nothing to
match on. Envelope fields (`id`, `occurredAt`, `meta`) are not available either; `source` and
`type` have their own selectors.

Ops by kind: **domain** all text ops plus `domain_matches`; **path** all text ops; **enum**
`eq`, `neq`, `in`, `exists`; **int** `eq`, `neq`, `gt`, `lt`, `exists`; **timestamp** `gt`,
`lt`, `exists`.

## Limits

| What                          | Limit      |
| ----------------------------- | ---------- |
| Name                          | 100        |
| Priority                      | 0 to 1000  |
| Actions per rule              | 10         |
| Conditions per `all`/`any`/`none` | 20     |
| `type` patterns               | 20         |
| `type` pattern length         | 128        |
| Condition value length        | 256        |
| `in` entries                  | 50         |
| `*` per glob                  | 8          |
| `coarsen` segments            | 0 to 10    |
| Tag length                    | 32         |
| `set_retention` days          | 1 to 3650  |

A cap on the number of rules per user belongs to the rules API (M4-04).

## Evaluation (for M4-02)

Input: one event, the user's enabled rules, and the integration's `default_policy`
(`deny` or `allow`; a new extension is `deny`). Output: a decision, the (possibly reshaped)
event and a trace.

1. Keep the enabled rules of the stage, sorted by `priority` ascending (lowest first). Ties:
   rules with `drop` first, then by `id`, so the order is deterministic. ⚑
2. A rule **matches** when every present part of `when` holds.
3. **Decision (collect stage).** The first matching rule with a deciding action wins. At the
   same priority `drop` beats `allow`. If no matching rule decides, `default_policy` decides.
4. **Transforms.** `redact`, `coarsen` and `keep_query` from matching rules apply in rule
   order, then `then` order. They apply whichever rule decides: a later rule that coarsens
   paths still applies to an event that an earlier rule allowed. ⚑ (Transforms only remove
   data, except `keep_query`, so applying them everywhere is the safe reading.)
5. A `drop` decision ends evaluation: the event is not stored and only counters are kept
   (invariant 2).
6. **Process stage** runs on events that `collect` kept: matching rules add `tag`s and
   `set_retention`. If two rules set a retention, the smaller number of days wins. ⚑
7. **Fail closed.** If the rule set is missing, fails validation, or evaluating throws, nothing
   is collected or stored (invariant 1). An invalid rule invalidates the whole set. It is
   never skipped.

### Trace (proposed ⚑)

Stored with each event and shown by "why is this here". M4-02 puts the schema in `contracts`.

```json
{
  "ruleSetVersion": 7,
  "matched": [{ "ruleId": "0192…", "actions": ["allow", "coarsen"] }],
  "decidedBy": "0192…"
}
```

`decidedBy` is a rule id, or `"default_policy"`. `actions` lists action **names** only, never
their values, so a trace cannot hold a domain, a path or a tag.

## Open items

These need an answer before the task named on the right.

1. **`keep_query` has nowhere to put the query (M4-05, M4-06).** The rule action exists and
   takes no parameters, but every event schema is strict and `path` rejects `?` and `#`. Keeping
   a query needs an event-schema change (for example a new optional field, or a `typeVersion`
   2 for `browser.page_visited`). Until it is decided, the engine can report that `keep_query`
   matched, and the extension keeps stripping queries.
2. **`coarsen` to none leaves `/`** because `path` is required (M4-02).
3. **Semantics marked ⚑ above** (priority direction, transforms apply regardless of the
   deciding rule, tie-breaking, smallest retention wins, apex and `*.`) (M4-02).
4. **Rule-set size cap** per user (M4-04).
