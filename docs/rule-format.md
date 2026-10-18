# Rule format (draft)

> **Status:** draft. The schema (M4-01) is real: `packages/contracts/src/rules.ts`,
> `rule-fields.ts`, `rule-glob.ts`, and the API will validate with it on save. The engine (M4-02) is
> `packages/rules`; the [Evaluation](#evaluation) section describes what it does. Items marked ⚑
> were chosen in M4-01 and went in with it; they are open to change until the rules API (M4-04).

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

A user can have at most 100 rules (`RULES_PER_USER_MAX`); the rules API refuses the 101st with `409 rules.limit_reached`.

## Evaluation

Implemented by `packages/rules` (M4-02). The extension, the API and the "test this rule" preview
all call it, so they give the same answer.

```ts
const compiled = compileRuleSet({ version, rules });      // validates, drops disabled, sorts
if (!compiled.ok) /* fail closed: collect nothing */;
const result = evaluate(event, compiled.ruleSet, policy, { source, process });
```

- `compileRuleSet(input)` checks the whole set with `ruleSetSchema` (every rule, unique ids). One
  invalid rule, even a disabled one, invalidates the set: a rule is never skipped. Its issues
  never contain a rule's values. Build it once per rule-set version and reuse it.
- `evaluate(event, ruleSet, policy, context)`: `policy` is the integration's `default_policy`;
  `context.source` is its kind (`browser-extension` or `http`); `context.process` is `false` in
  the extension, which has no process rules. `event` is `unknown`: it is checked with
  `parseEvent()` first.

Result, one of:

| `decision` | Carries                                                                  | Meaning                                         |
| ---------- | ------------------------------------------------------------------------ | ----------------------------------------------- |
| `allow`    | `event`, `tags`, `retentionDays`, `keepQuery`, `trace`                   | Collect/store `event` (already redacted/coarsened). |
| `drop`     | `trace` only                                                             | Do not collect. There is no event to store.     |
| `error`    | `reason` only                                                            | Collect nothing (invariant 1). Server: `rejected(rule_error)`. |

`error` reasons: `invalid_context` (unknown source), `invalid_event` (fails `parseEvent`),
`invalid_result` (a transform would leave an event `parseEvent` rejects), `failed` (anything
threw, for example a malformed rule set). `evaluate` never throws.

### Order of evaluation

1. **Order.** Enabled rules of a stage are sorted by `priority` ascending (lowest first). Ties:
   rules that `drop` first, then by `id`, so the order never depends on how rules arrive.
2. **Match.** A rule matches when every present part of `when` holds. Conditions are checked
   against the event **as it came in**, so a rule that coarsens a path cannot hide it from a
   later `drop` rule that looks at that path.
3. **Decision (collect).** The first matching rule with `allow` or `drop` decides. If none does,
   `policy` decides: only the exact value `allow` collects; any other value is `deny`.
4. **`drop` ends evaluation.** The result has no event, and only counters are kept (invariant 2).
5. **Transforms.** `redact`, `coarsen` and `keep_query` of every matching rule apply in rule
   order, then `then` order, whichever rule decides. So `allow` at priority 10 and a coarsen at
   priority 50 give an allowed, coarsened event. After the transforms the event is validated
   again; if it is no longer valid, the result is `error`.
6. **Process.** Skipped for a dropped event and when `context.process` is false. Process rules
   are matched against the event that will be stored, so a rule cannot tag on something that
   was redacted. Matching rules add their `tag`s (each once, in rule order), and the smallest
   `set_retention` wins. Process rules never change the event or the decision.
7. **Fail closed.** A rule set that fails `compileRuleSet`, an unknown source, an invalid event,
   an unknown op or action, or any exception is `error`. A condition on an op the engine does
   not know throws; it is never read as "false", which could let a `drop` rule fall through.

`keepQuery` is `true` when a `keep_query` rule matched. See [Open items](#open-items).

### Trace

`ruleTraceSchema` in `packages/contracts/src/rule-trace.ts`. Stored with each event and shown by
"why is this here".

```json
{
  "ruleSetVersion": 7,
  "matched": [{ "ruleId": "0192…", "actions": ["allow", "coarsen"] }],
  "decidedBy": "0192…"
}
```

- `matched` lists every rule that matched, in evaluation order, collect rules then process rules.
  A rule that matched after the deciding one is listed too; only `decidedBy` decided.
- `decidedBy` is a rule id, or `"default_policy"`.
- `actions` lists action **names** only, never their values, so a trace cannot hold a domain, a
  path or a tag (invariant 6).
- A `drop` result has a trace but no event.

## Open items

1. **Re-evaluating a rewritten event can change the decision (decide before M4-05).** The server
   re-applies the collect rules to events the extension already transformed (PLAN §3). Conditions
   look at the incoming event, so a rule that both reads and rewrites a field can stop matching its
   own output. Example: `path starts_with /work/` with `coarsen 1` and `allow` keeps
   `/work/projectA/doc` as `/work`; evaluated again, `/work` no longer matches, so the default
   policy drops it. The same happens with `exists` plus `redact` on one field. Matching the
   original event is what stops a coarsen from hiding a path from a later `drop` rule, so a fix
   has to keep that and make an allowed output re-evaluate to `allow`. Options for the owner: the
   server skips the rules that the extension already applied (trust `meta.ruleSetVersion`), or the
   save-time validation refuses a rule that reads a field it rewrites, or the server re-checks
   only `drop` rules. `evaluate` is pinned by a "known limitation" test until then. The M4-03 property tests claim a
   stable *event* on re-evaluation only for rule sets whose conditions read fields no rule rewrites
   (`evaluate.property.spec.ts`); the transforms are idempotent unconditionally.
2. **`keep_query` has nowhere to put the query (before M4-05 and M4-06).** The action exists and
   takes no parameters, and the engine reports `keepQuery: true`. But every event schema is
   strict and `path` rejects `?` and `#`. Keeping a query needs an event-schema change (for
   example a new optional field, or `typeVersion` 2 for `browser.page_visited`). Until it is
   decided, the extension keeps stripping queries.
3. ~~Rule-set size cap~~ Done in M4-04: 100 rules per user, enforced by the rules API (`ruleSetSchema` itself has no cap).
4. **Server wiring (M4-05).** `policy` and `context.source` must come from the authenticated
   integration row, never from the request body (invariant 4). The `error` decision becomes `rejected(rule_error)`, which also
   needs `ingest.rule_error` in `INGEST_ERROR_CODES`. The extension wiring is M4-06.
