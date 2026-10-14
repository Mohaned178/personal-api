# ADR 0002: MV3 extension state persistence (Spike A)

- **Status:** Accepted for the automated part (M0-10, 2026-10-14). Idle, screen lock, real OS
  window blur and a real Chrome quit are **pending manual verification** by the user with
  `docs/spikes/mv3-lifecycle-manual-protocol.md`; this ADR is updated with those results.
- **Prototype:** `spikes/mv3-lifecycle` (throwaway WXT package, never shipped).
- **Tests:** `apps/e2e/tests/spike-mv3.spec.ts`, contract in `apps/e2e/support/spike.ts`.
- **Affects:** M2-04 (capture engine), M2-05 (persistent queue and sync).

## Context

The extension runs in an MV3 service worker that Chrome can stop at any moment. Every bit of
in-memory state is lost when it does: the queue of captured events, which page is in focus and since
when, and any timer. PLAN §11 lists this as the first risk and requires a spike before anything is
built on it. M0-10's done-when:

- a Playwright test kills the service worker 20 times during capture with **zero lost events**;
- scripted blur and tab-switch segments are **off by less than 2 s**;
- browser restart is covered by a persistent-context relaunch;
- idle and lock follow a written manual protocol;
- this ADR records the results and a go/no-go.

Questions the spike had to answer: where to keep the open segment and the "last alive" time; how
to recover an open segment after a worker kill and after a browser restart (and what `endedAt` to
use); how to handle idle (60 s) and lock; the 30-minute cap; whether IndexedDB writes survive a kill
mid-write and what `durability` buys; how to dedupe.

## Options considered

### Where the state lives

| Option | Survives worker kill | Survives browser restart | Atomic with the queue | Notes |
| --- | --- | --- | --- | --- |
| In memory (globals) | no | no | n/a | Rejected outright: this is the failure mode. |
| `chrome.storage.session` | yes | **no** (cleared on restart) | no | Ideal *restart detector*, wrong place for the open segment: a restart would silently drop it. |
| `chrome.storage.local` | yes | yes | **no** | Cannot share a transaction with an IndexedDB queue. "Close segment + enqueue `focus_segment`" becomes two writes; a kill in between either loses the segment or emits it twice. |
| **IndexedDB, same database as the queue** | yes | yes | **yes** | One readwrite transaction over `queue` + `state` makes "state change + the events it produces" all-or-nothing. |

### Recovering the open segment after a browser restart

| `endedAt` choice | Effect |
| --- | --- |
| Time of recovery (now) | Inflates the segment by the whole downtime. Rejected (PLAN §11). |
| Drop the segment | Loses real attention silently. Rejected by the contract ("never dropped"). |
| **Last moment known alive** (last focus step or heartbeat), capped | Never inflates. Undercounts by at most the time since the last step, bounded by the heartbeat period (30 s) plus alarm lateness. **Chosen.** |

### Capture write path

| Option | Measured |
| --- | --- |
| A. Every listener enqueues onto one serialized chain; each step first awaits `storage.session`, `windows.getLastFocused`, `tabs.query`, `idle.queryState`, then commits the visit and the focus change together | **Lost events.** 2 lost navigations in ~180 kills. The one that was pinned down (1 in a 6 × 20-kill measurement) happened in the "kill while the next navigation is loading" pattern; the other surfaced as a missing visit a few rounds later and was not attributed to a pattern. |
| **B. A completed navigation is committed straight from the listener in its own transaction** (database handle and session id opened at worker start, no chrome API awaited first); focus steps stay on the serialized chain | **0 lost, 0 duplicated** in 460 kills (details below). **Chosen.** |

Option A's loss is a real MV3 property, not a test artifact: Chrome dispatches the `tabs.onUpdated`
event to the running worker, the worker is stopped before its transaction commits, the transaction
aborts (atomicity held: no half-written state), and **Chrome does not redeliver the event**. By the
time the next worker starts, the tab has already moved on to the next page, so nothing can recover
that visit. The only defence is to shrink the window between delivery and commit to a few
milliseconds, which option B does.

## Decision

For M2-04 and M2-05:

1. **IndexedDB holds everything that must survive**: the event queue and a state record (open
   segment, `lastAliveAt`, per-tab marks, counters), in one database. `chrome.storage.session` holds
   only a random **browser-session id** (it is cleared on browser restart, which is exactly the
   signal needed). Nothing important lives in memory; the in-memory database handle and session id
   are caches of persisted values.
2. **Every transition is one readwrite transaction over queue + state**: read the state record,
   compute synchronously (pure function), write the new state and the produced events, resolve only
   on `complete`. No `await` of anything but IndexedDB inside the transaction (a chrome API await
   would let the transaction auto-commit half-way). Because IndexedDB runs overlapping readwrite
   transactions in creation order, a capture racing a focus step cannot overwrite the other's update.
   If the compute throws, the transaction is aborted: nothing is stored (fail closed).
3. **Capture commits immediately from the listener** (option B). Open the database and resolve the
   session id at worker start, so the first event does not wait for them either.
4. **Focus segments are level-triggered**: on every relevant event (tab activated/updated/removed,
   window focus changed, idle state changed, heartbeat alarm, worker start) a serialized focus step
   reads what *should* be open now (`windows.getLastFocused()` must report `focused`, the active tab
   of that window must be a non-incognito http(s) page, `idle.queryState(60)` must be `active`) and
   diffs it with the persisted open segment. A missed or reordered event cannot leave a wrong
   segment open; the next event or heartbeat corrects it.
5. **Close rules**: tab switch, navigation away, focus change and lock end the segment at the
   event time. **Idle ends it at `now − 60 s`** (chrome.idle reports idle 60 s after the last
   input; that minute was not attention), never before `startedAt`. Every segment is capped at
   30 minutes; continuous attention is split into back-to-back 30-minute segments on the heartbeat.
6. **Restart and gap recovery**: the open segment carries the session id it was opened in. A focus
   step that finds an open segment from another session closes it at `lastAliveAt` (capped). The
   same rule applies within a session when more than 90 s passed since the last step (machine
   sleep, missed alarms). `lastAliveAt` is updated by focus steps only, not by captures, so a page
   load right after waking cannot hide a gap.
7. **Heartbeat**: one `chrome.alarms` alarm with a 30 s period (Chrome's minimum), recreated at
   worker start only if missing. Never `setTimeout`/`setInterval`. M2-05's flush alarm can be the
   same alarm.
8. **Reconciliation backstop**: at every worker start, the open tabs are compared with the per-tab
   marks (last recorded page, the time it was recorded, the session); a completed http(s) page that
   was never recorded is emitted as a recovered visit, and the late event for it, if it still
   arrives, is skipped once. Marks newer than the tab listing win, marks from another session are
   ignored (tab ids are reused after a restart).
9. **Ids and dedupe**: every event gets `crypto.randomUUID()` at capture, inside the same
   transaction that stores it, so a retried flush always resends the same id and the server's
   `UNIQUE (user_id, integration_id, client_event_id)` makes delivery effectively-once. Within the
   client, the per-tab mark is what stops a reconciled visit and its late event from both landing.
10. **Durability**: use `durability: "strict"`. It costs ~1.4 ms per commit (measured below) at a
    few commits per minute. It does **not** protect against a worker kill (atomicity does that, and
    the commit is handed to the browser process either way); it protects against losing the last
    commits on an OS crash or power cut, where Chrome's default (measured as fast as `relaxed`) may
    not have flushed.
11. Use the `idb` wrapper in M2-05 as the plan says: it supports the `durability` option and the
    read-compute-write-in-one-transaction pattern, provided nothing but `idb` calls is awaited inside
    the transaction. The spike used raw IndexedDB only to avoid a dependency in a throwaway package.

## Measured results

Environment: Windows 11 Pro, Node 24.21, Playwright 1.63.0, bundled Chromium 153.0.8010.12 in new
headless mode, one Playwright worker. Worker kills use CDP `ServiceWorker.stopWorker`, which is
harsher than Chrome's own termination (after 30 s without events, or an event running for over
5 minutes), which does not cut a short event handler off half-way.

### Go/no-go criteria

| Criterion | Target | Result | |
| --- | --- | --- | --- |
| Events lost across forced worker kills | 0 in 20 kills | **0 lost, 0 duplicated in 460 kills** (8 runs of the 20-kill spec test + a 15 × 20-kill measurement with 525 navigations); query strings and fragments never stored | pass |
| Tab-switch / blur segment error | < 2 s | **max 66 ms** (table below) | pass |
| Browser restart | covered by relaunch | queue intact, no duplicate, open segment closed, never inflated | pass |
| Idle (60 s) and lock | manual protocol | protocol written; **not yet run** | pending |

E2E runs on the final prototype: `pnpm test:e2e` 3 times (10/10 tests each, including the 6
existing extension tests) and the spike spec with `--repeat-each 5` (20/20). No flaky result.

### Segment error (5 runs per scenario, measured duration minus scripted duration)

| Scenario | Segment | Error range |
| --- | --- | --- |
| Tab switch A → B, worker killed and restarted while B is open, then blur | A (3 s) | +7 … +10 ms |
| | B (3 s, spans the kill) | +47 … +48 ms |
| Tab switch arrives while the worker is stopped (the event wakes it), then blur | A (3 s) | +56 … +66 ms (worker cold start) |
| | B (1.5 s) | −11 … +4 ms |

Segment A always ended exactly where B started (gap 0 ms). The segment open across a kill stayed
whole: the restarted worker continued it from IndexedDB.

### Browser restart (9 relaunches of the same profile, page in focus ~2.05 s before close)

In 3 of the 9 runs the worker was killed right before closing the browser, to force the recovery
path.

| How the segment was closed | Runs | Recovered duration | `endedAt` vs. close |
| --- | --- | --- | --- |
| During shutdown (Chrome delivered the closing tab/focus events and the step committed) | 5 (none of the killed ones) | 2 046–2 074 ms, within 0.1 s of the real time | 30–60 ms after the test's close mark (inside the close call) |
| On the next start, at `lastAliveAt` (shutdown events not processed, or the worker was killed first) | 4 (3 killed + 1 not) | 11–16 ms | ~2 s before close |

Both paths never counted the 4 s the browser was down. The heartbeat path undercounts by the time
since the last focus step: here ~2 s (the test closes before any heartbeat), in real use at most
the 30 s heartbeat period plus alarm lateness.

### Other measurements and observations

- Reconciliation at worker start: with option A it fired on every "event wakes the worker" kill
  (10 per 20 kills) and every one was followed by the late event itself (`dedupedEvents` = 10),
  i.e. Chrome **does** queue events for a stopped worker and delivers them after the restart; only
  events delivered to a dying worker are lost. With option B it never fired in 460 kills (the
  capture always committed first), so it remains an untested-in-e2e backstop covered by unit tests.
- IndexedDB commit latency in the service worker (200 single-record transactions each):
  `strict` p50 1.6 ms / p95 2.2 ms / max 3.2 ms; `relaxed` and Chrome's default both p50 0.2 ms /
  p95 0.4 ms / max 0.7 ms.
- Headless Chromium reports `focused: true` for the window of the active page, so
  `windows.getLastFocused()` works as the focus source there; opening a second focused window fires
  `windows.onFocusChanged`.

## Limitations

- **Blur in headless is an approximation**: the tests move focus to a second Chrome window (whose
  only tab is about:blank). Real OS focus loss (`WINDOW_ID_NONE`, Alt+Tab, minimize) is only covered
  by the manual protocol.
- **Idle (60 s), screen lock, a real Chrome quit/crash and system sleep are not verified.** The
  logic is unit-tested with fixed clocks (`spikes/mv3-lifecycle/test/core.spec.ts`), but whether
  Chrome reports these states as assumed (and how late) is pending the manual protocol. In
  particular, the `now − 60 s` idle rule and its interaction with video playback need the M1/M1b
  results.
- CDP `stopWorker` is not Chrome's natural termination, and the kill rate here (every few hundred
  ms) is far beyond reality. That makes the result conservative for event loss, but the residual
  window (event delivered, worker stopped within ~2 ms, before the commit is sent) is not provably
  zero: the reconciliation backstop narrows it further for the last navigation of each tab.
- `page_visited` was captured on `status: "complete"`; PLAN §4 says "navigation committed". The
  same write path works for either; M2-04 picks one. Reloads count as visits; SPA (history API)
  navigations, `tab_opened`/`tab_closed` and session start/end events were not prototyped.
- Zero-length segments are kept (for example a restart-recovered segment whose last step was its
  start). M2-04 decides whether a minimum duration applies.
- The 30-minute split runs on the heartbeat, so a split segment can be noticed up to ~30 s late; the
  boundary itself is exact (`startedAt + 30 min`).

## Go / no-go

**Go** for building the M2 capture engine and queue on an MV3 service worker with IndexedDB, using
the design above. The automated criteria are met with a wide margin. The pending manual checks
(idle, lock, real blur, real quit) can change close rules (for example the idle offset) but not the
persistence architecture, so they do not block M2. If any of them fails, record it here and adjust
the rule in M2-04.

## Consequences for M2-04 and M2-05

- **M2-04 (capture engine)**: listeners at top level only; capture writes its event in its own
  transaction directly from the listener; the focus state machine is a pure function run inside a
  transaction behind a serialized chain, level-triggered from `getLastFocused` + active tab + idle
  state; session id in `chrome.storage.session`; restart and gap recovery at `lastAliveAt`; idle
  close at `now − 60 s`; 30-minute split; incognito and non-http(s) ignored before anything is
  stored; reconciliation of open tabs on worker start with per-tab marks. Its unit tests (mocked
  chrome, fake timers) should port the cases in `spikes/mv3-lifecycle/test/core.spec.ts`.
- **M2-05 (queue and sync)**: same database, `idb`, `durability: "strict"`; ids generated in the
  capture transaction; the flush alarm doubles as the heartbeat; deleting sent items happens in a
  transaction after the server's per-item result, so a worker killed mid-flush resends the same ids
  and the server dedupes them. The "restart mid-flush" test should reuse the M0-09 CDP kill helpers
  and this spike's kill patterns (settled, mid-burst, wake-by-event, in-flight navigation).
