# ADR 0002: MV3 extension state persistence (Spike A)

- **Status:** Accepted: **go, conditional on the manual protocol** (M0-10, 2026-10-14). The
  automated criteria passed. Idle, screen lock, real OS window blur and a real Chrome quit are
  **pending manual verification** by the user with `docs/spikes/mv3-lifecycle-manual-protocol.md`;
  see [Manual verification](#manual-verification) for what would turn the go into a redesign or a
  no-go. This ADR is updated with those results.
- **Prototype:** `spikes/mv3-lifecycle` (throwaway WXT package, never shipped).
- **Tests:** `apps/e2e/tests/spike-mv3.spec.ts`, contract in `apps/e2e/support/spike.ts`.
- **Affects:** M2-04 (capture engine), M2-05 (persistent queue and sync).
- **Firefox (Spike C, M2-00b):** see [Firefox (Spike C)](#firefox-spike-c). Go on Firefox as
  well, with one required change (listeners return their work promise), conditional on the
  Firefox manual protocol.

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
| **B. A completed navigation is committed straight from the listener in its own transaction** (database handle and session id opened at worker start; no chrome API awaited first, except that the first capture after a cold start waits for the in-flight `storage.session` read (and, on the first worker of a browser session, the write of a new id)); focus steps stay on the serialized chain | **0 lost, 0 duplicated** in 460 kills (details below). **Chosen.** |

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
3. **Capture commits immediately from the listener** (option B). Start opening the database and
   reading the session id at worker start. A capture that arrives right after a cold start still
   awaits that in-flight `storage.session.get` (and, on the first worker of a browser session, the
   write of a new id) and the database open before its transaction, so the window between delivery
   and commit is wider for the first event of a worker than for later ones; no other chrome API is
   awaited on the capture path.
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
   same alarm. Each tick resets Chrome's ~30 s service-worker idle timer, so with this period the
   worker is rarely stopped for long (see M2-05 under Consequences).
8. **Reconciliation backstop**: at every worker start, the open tabs are compared with the per-tab
   marks (last recorded page, the time it was recorded, the session); a completed http(s) page that
   was never recorded is emitted as a recovered visit, and the late event for it, if it still
   arrives, is skipped once. Marks newer than the tab listing win, marks from another session are
   ignored (tab ids are reused after a restart).
   Reconciliation is a second emission path and MUST go through the same rule gate as capture:
   deny by default, fail closed (invariants 1 and 2). If rules are missing, invalid or throw,
   nothing is emitted and nothing is stored. Per-tab marks, the open segment and `lastAliveAt` are
   written only after the rule check passes; a dropped visit leaves no domain + path behind (if a
   mark is still needed for dedupe, it holds only a non-reversible key or the event id). A recovered
   visit carries `ts` = the reconciliation time (now), not the real navigation time, which is
   unknown. The spike has no rule engine, so none of this was prototyped: its marks store domain +
   path unconditionally.
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

**Provenance.** The e2e spec (`apps/e2e/tests/spike-mv3.spec.ts`) and the unit tests
(`spikes/mv3-lifecycle/test/core.spec.ts`) are committed and can be rerun. The following figures
came from **ad-hoc harnesses that were not committed**, so they cannot be reproduced from the repo
and should be read as recorded observations: the option A loss figures (2 lost in ~180 kills, 1 in
the 6 × 20-kill measurement), the 15 × 20-kill measurement (300 of the 460 kills below), the
9-relaunch browser restart table, and the IndexedDB commit latency benchmark.

### Go/no-go criteria

| Criterion | Target | Result | |
| --- | --- | --- | --- |
| Events lost across forced worker kills | 0 in 20 kills | **0 lost, 0 duplicated in 460 kills** (8 runs of the committed 20-kill spec test + a 15 × 20-kill ad-hoc measurement with 525 navigations); query strings and fragments never stored | pass |
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

### Browser restart (9 relaunches of the same profile, page in focus ~2.05 s before close; ad-hoc harness)

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
- IndexedDB commit latency in the service worker (200 single-record transactions each; ad-hoc
  harness):
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
- The 30-minute split runs on the heartbeat, so a split segment can be noticed up to ~30 s late.
  For continuous attention on the same page the split boundary is exact (`startedAt + 30 min`).
  But a segment that is closed for any other reason (tab switch, navigation, blur, idle, lock,
  restart or gap recovery) after `startedAt + 30 min` and before the heartbeat split it is clamped
  to the cap, and the attention between `startedAt + 30 min` and the close is dropped. The loss is
  bounded by the heartbeat period plus alarm lateness. To be fixed in M2-04 (for example by
  applying the split before the close).

## Manual verification

**Status: pending.** The manual protocol has not been run yet. Results are recorded in the
[Results table](../spikes/mv3-lifecycle-manual-protocol.md#results) of
`docs/spikes/mv3-lifecycle-manual-protocol.md`; summarise them here (date, OS and Chrome version,
pass or fail per scenario, the heartbeat state of each run, and whether the worker was seen stopped
before each key event).

The 30 s heartbeat alarm resets Chrome's ~30 s service-worker idle timer, so with it on the worker
is usually already running when an idle, lock or focus event arrives, and such a run does not test
the wake path (the event waking a stopped worker, and the woken worker getting the boundary right).
The spike therefore has a manual-only switch, persisted in `chrome.storage.local`
(`spike.heartbeatEnabled`, default on) and set with `__spike.setHeartbeat(enabled)`; every worker
start creates or clears the alarm to match it, so it stays off across worker restarts until turned
back on. The pure part of that switch is unit-tested (`spikes/mv3-lifecycle/test/heartbeat.spec.ts`);
the alarm glue in `background.ts` has **not** been exercised in a real Chrome profile with a stopped
worker yet and is checked as part of the protocol. The protocol runs M1, M1b, M2 and M3 with the
heartbeat **off** and triggers each key event (idle, lock, unlock, blur, return to Chrome, minimize,
restore) only after at least 45 s without any Chrome event or interaction and with
`chrome://serviceworker-internals` showing the worker **STOPPED** (watched in a separate window and
never reloaded, since a reload is a `tabs.onUpdated` event that wakes the worker). M4, M4b and M5
run with the heartbeat **on**, because their recovery closes the open segment at `lastAliveAt`,
which the heartbeat keeps fresh. A run of M1–M3 with the heartbeat on, with DevTools open on the
worker, or whose worker was not seen stopped right before a key event, does not verify the wake
path for that event. (The unlock in M2 cannot be watched while the screen is locked; it is recorded
as not observable.)

What the outcomes mean for the go:

- **Go stands, rule adjusted in M2-04**: boundaries consistently outside the tolerance by a fixed
  amount (for example idle detection lagging more than 5 s, so the `now − 60 s` offset needs
  tuning); Chrome reporting or not reporting idle while video plays (M1b), which sets the policy for
  media; the heartbeat recovery ending segments earlier than expected but never inflating them.
- **Redesign of the focus or idle source** (the go is suspended for M2-04's focus segments until it
  is redesigned and rechecked):
  - `windows.getLastFocused()` does not report `focused: false` on a real OS blur (Alt+Tab to
    another application or minimize, M3), so the level-triggered focus check cannot see blur;
  - idle or lock events (`idle.onStateChanged`) do not wake a stopped worker (heartbeat off, worker
    seen stopped), or wake it too late, so idle and lock boundaries miss the 5 s tolerance (M1, M2);
  - focus events do not wake a stopped worker (heartbeat off, worker seen stopped) in time for the
    2 s tolerance (M3);
  - after a real quit, crash or sleep, a segment counts any of the downtime (M4, M4b, M5).
- **No-go for the persistence architecture**: after a real Chrome quit or crash (M4, M4b), queued
  `page_visited` events or closed segments are missing, or the same visit appears twice; that would
  mean IndexedDB state does not survive as the automated relaunch test showed.

## Go / no-go

**Go, conditional on the manual protocol**, for building the M2 capture engine and queue on an MV3
service worker with IndexedDB, using the design above. The automated criteria are met with a wide
margin. The pending manual checks (idle, lock, real blur, real quit) are expected to change close
rules (for example the idle offset) rather than the persistence architecture, so M2 work can start;
that expectation is not verified yet. If a result falls under the redesign or no-go outcomes in
[Manual verification](#manual-verification), record it here and revisit this decision for the
affected part; a rule-level failure is fixed in M2-04.

## Consequences for M2-04 and M2-05

- **M2-04 (capture engine)**: listeners at top level only; capture writes its event in its own
  transaction directly from the listener; the focus state machine is a pure function run inside a
  transaction behind a serialized chain, level-triggered from `getLastFocused` + active tab + idle
  state; session id in `chrome.storage.session`; restart and gap recovery at `lastAliveAt`; idle
  close at `now − 60 s`; 30-minute split; incognito and non-http(s) ignored before anything is
  stored; reconciliation of open tabs on worker start with per-tab marks. Reconciliation (the
  startup and restart emission path) MUST go through the same rule gate as capture: deny by
  default, fail closed (invariants 1 and 2). Per-tab marks, the open segment and `lastAliveAt` are
  written only after the rule check passes; marks for a dropped visit hold only a non-reversible key
  or the event id, never its domain + path. Recovered visits carry `ts` = now, not the real
  navigation time. Fix the 30-minute clamp loss described under Limitations. Its unit tests (mocked
  chrome, fake timers) should port the cases in `spikes/mv3-lifecycle/test/core.spec.ts`, plus
  cases for the rule gate on both emission paths.
- **M2-05 (queue and sync)**: same database, `idb`, `durability: "strict"`; ids generated in the
  capture transaction; the flush alarm doubles as the heartbeat; deleting sent items happens in a
  transaction after the server's per-item result, so a worker killed mid-flush resends the same ids
  and the server dedupes them. The "restart mid-flush" test should reuse the M0-09 CDP kill helpers
  and this spike's kill patterns (settled, mid-burst, wake-by-event, in-flight navigation).
  A 30 s production flush alarm (doubling as the heartbeat) resets Chrome's ~30 s worker idle
  timer on every tick, so it may keep the service worker almost always alive. That is not
  necessarily wrong, but it was not measured here: M2-05 should measure it deliberately (how often
  the worker actually stops with the chosen period, the cost of keeping it alive) and choose the
  period on purpose. It also means a worker that "never stops" in everyday testing hides the wake
  path, so wake-path tests must stop the worker explicitly (CDP kill, or the alarm switched off as
  in this spike's manual protocol).

## Firefox (Spike C)

M2-00b re-ran the design above (option B) on a **Firefox MV3 event page**, using the same
throwaway prototype built with `wxt build -b firefox --mv3`. Firefox does not use a service worker
for MV3 backgrounds. The background is a non-persistent page that Firefox suspends after
`extensions.background.idle.timeout` (30 s by default) without an event, and wakes for primed
(top-level) listeners.

- **Tests:** `apps/e2e/tests/spike-mv3-firefox.spec.ts` (7 tests, mirroring the Chromium spec's
  scenarios one for one), run with `pnpm --filter @personal-api/e2e test:e2e:firefox`
  (`playwright.firefox.config.ts`; Playwright is only the test runner there).
- **Harness:** `apps/e2e/support/spike-firefox.ts`, Selenium (`selenium-webdriver` 4.49.0) +
  geckodriver, because Playwright's Firefox cannot load WebExtensions. selenium-manager downloads
  geckodriver when it is not on `PATH`. The build is installed as a temporary add-on (release
  Firefox refuses unsigned add-ons otherwise) with a stable gecko id and a pinned moz-extension
  UUID, so a relaunch on the same profile sees the same IndexedDB.
- **Manual protocol:** `docs/spikes/mv3-lifecycle-firefox-manual-protocol.md` (idle, lock, real OS
  blur, real quit and crash).

### How suspension is forced

Firefox has no equivalent of CDP `stopWorker`. In Marionette's chrome context, the harness calls
`extension.terminateBackground()` on demand with its default options: the same function Firefox's
idle timer calls after 30 s. It tears the page down (`backgroundState` "stopped", all in-memory
state gone) and re-primes the persistent listeners. Reads of the queue run inside the event page
through Marionette's window actor, so observing opens no tab and fires no event.

Firefox's termination **declines once** while a promise returned by one of the page's listeners is
pending (`pendingRunListenerPromisesCount` in `ext-backgroundPage.js`; the parent process tracks
the promise from the moment it dispatches the event). It then clears that set and restarts the 30 s
timer. The harness honours that rule but compresses the wait: after a decline it waits only until
the promises it declined for have settled, then asks again. What it skips is the 30 s without
events that precedes a real termination. So the page is terminated far more often, and at far
worse moments, than Firefox ever would on its own: between the events of one navigation,
milliseconds after a commit, or while a page is loading.

### Finding: listeners must return their work promise

Run unchanged, the Spike A prototype lost visits under forced suspension on Firefox. The listener
ran synchronously and returned nothing, so Firefox counted the event as handled at once. A
termination right after that cut the IndexedDB transaction off before it committed. Atomicity held
(no half-written state), but the visit was gone: the same failure mode as option A on Chromium.
An earlier iteration of the spike observed this with an ad-hoc harness, and it was **not
re-measured** for this ADR (the comparison run without the fix was skipped). The mechanism matches
Firefox's source: without a returned promise, the listener's tracked promise resolves as soon as
the listener returns.

The fix is in `spikes/mv3-lifecycle/entrypoints/background.ts` (`keepAliveUntil`): **every
listener returns a promise that settles once the work it started has committed or failed.** The
promise resolves to `undefined` and never rejects. Firefox then keeps the page alive until the
commit, not just until the event is delivered. Chromium ignores the return value of these
listeners, so the same code is correct on both browsers. The value must be `undefined` because
Firefox structured-clones whatever a listener's promise resolves to.

### Measured results (Firefox)

Environment: Windows 11 Pro, Node 24.21, Firefox 158.0 (release) headless, geckodriver 0.37.1,
selenium-webdriver 4.49.0, one worker.

| Criterion | Target | Result | |
| --- | --- | --- | --- |
| Events lost or duplicated across forced suspensions | 0 in 20 | **0 lost, 0 duplicated in 340 suspensions**: 7 runs of the committed 20-suspension test (140 suspensions) plus an ad-hoc 10 × 20 measurement (200 suspensions, 360 navigations, `recoveredVisits` 0, so capture always committed first). Every suspension really restarted the page (21 distinct boot ids per test). Query strings and fragments were never stored. | pass |
| Tab-switch / blur segment error | < 2 s | Within the spec's 1.5 s tolerance in all 7 runs of both segment tests: one suspends inside the open segment, the other lets the tab switch itself wake the suspended page. Exact error figures were not recorded for this ADR. | pass |
| Browser restart | covered by relaunch | 7 of 7 runs: queue intact, nothing duplicated, no visit added, and the open segment was closed without counting the 4 s the browser was down. | pass |
| Idle (60 s), lock, real OS blur, real quit and crash | manual protocol | Protocol written; **not yet run**. | pending |

Provenance: the 7 runs are two single `test:e2e:firefox` runs plus one with `--repeat-each 5`
(49 of 49 tests passed, no flaky result). The 10 × 20 measurement came from an ad-hoc spec that was deleted
before commit.

### Per-browser differences M2-04 and M2-05 must handle

1. **Return the work promise from every listener** (see the finding above). On Firefox this keeps
   the commit inside the event page's lifetime; on Chromium it is harmless. It applies to M2-04's
   listeners and to M2-05's flush alarm handler. A unit test that each listener returns the
   promise of its commit is cheap insurance.
2. **Firefox has no `locked` state.** `idle.queryState` and `idle.onStateChanged` only report
   `active` and `idle`. This comes from reading Firefox 158's `ext-idle.js` source and was not
   measured. A screen lock therefore shows up either as `idle` 60 s after the last input (closed
   at `now − 60 s` by the idle rule, so not over-counted) or as a window focus loss, if the OS takes
   focus away from Firefox. **A lock shorter than 60 s may not be seen at all** and would count as
   attention; F2b of the Firefox protocol measures this. The state machine must treat `locked` as
   optional and never wait for it.
3. **How the page starts at browser launch.** At app startup Firefox starts an event page only if
   a `runtime.onStartup` listener was registered and persisted with the other primed listeners.
   Otherwise only the first primed event starts it. This comes from the source and was not
   measured. Keep the empty top-level `onStartup` listener so restart recovery runs at browser
   start on both browsers. The automated relaunch re-installs a temporary add-on, which is an
   install, not `onStartup`. A real quit with a permanently installed add-on is F4 of the manual
   protocol, and needs Developer Edition, Nightly or an AMO-signed build.
4. **Focus in headless Firefox.** After the blur window opens, `windows.getLastFocused()` returns
   that new window with `focused: true`, the same as a user switching to another browser window.
   The level-triggered check still works because it takes the active tab of the focused window
   rather than relying on the bare flag. Tests on Firefox must assert that the main window is no
   longer the focused one.
5. **What blocks suspension.** `terminateBackground` does nothing while DevTools is attached to
   the extension, and a pending listener promise postpones it by one idle period. Wake-path tests
   must keep DevTools closed and force suspension explicitly (the harness's `suspendBackground`).
6. **Storage and ids.** `storage.session` (the browser-session id) and IndexedDB with
   `durability: "strict"` behaved as on Chromium: the queue survived every suspension and every
   relaunch. A temporary add-on keeps its IndexedDB across a relaunch only because the harness pins
   the moz-extension UUID; a permanently installed add-on keeps its UUID without that.
7. **Heartbeat.** Firefox's idle timeout is also 30 s, so the 30 s heartbeat alarm keeps the page
   alive in practice, as on Chromium. M2-05's choice of flush period applies to both browsers.

### Go / no-go (Firefox)

**Go, conditional on the Firefox manual protocol.** M2-04 and M2-05 can be built on the same
design for both browsers. Difference 1 (listeners return their work promise) is a hard
requirement; differences 2 to 5 are handled in M2-04's state machine and tests. The automated
criteria pass with margin.

The protocol's results table has not been filled in yet. These outcomes would change the decision:

- **No-go:** after a real Firefox quit or crash (F4, F4b), queued events are missing or duplicated.
- **Redesign of the focus or idle source:** a real OS blur does not leave the main window
  unfocused (F3), or idle events do not wake a suspended page in time (F1).
