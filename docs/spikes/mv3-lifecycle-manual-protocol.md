# Spike A manual protocol: idle, lock, real window blur, browser restart

Part of M0-10 (see `docs/adr/0002-mv3-state-persistence.md`). Playwright covers service-worker
kills, tab switches, a headless approximation of window blur and a profile relaunch. It cannot
produce real OS input idleness, a screen lock, focus moving to another application, or a real
Chrome quit. Those are checked by hand with the steps below, and the results go in the table at
the end.

## Setup

1. Build the prototype: `pnpm --filter @personal-api/spike-mv3-lifecycle build`.
2. Use a **separate, empty Chrome profile** (not your everyday one). Branded Chrome ignores
   `--load-extension` but still supports *Load unpacked*: open `chrome://extensions`, turn on
   Developer mode, choose *Load unpacked* and select `spikes/mv3-lifecycle/.output/chrome-mv3`.
   Note the spike's extension id shown there. Load the spike **before** opening any test page, so
   every test tab's first load is recorded by its own event (see M4 step 1 for why this matters).
3. Only visit test pages such as `https://example.com/` and `https://example.org/`. The prototype
   keeps domain + path locally in IndexedDB and sends nothing, but results get pasted into this
   public repo, so do not record real browsing.
4. The service worker console: on `chrome://extensions`, click *service worker* under the spike.
   Each time you open it, paste this helper (it lives in the worker, so it is gone once the worker
   stops):

   ```js
   const t = (ms) => new Date(ms).toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 1 });
   const show = async () =>
     console.table((await __spike.segments()).map((s) => ({
       path: s.domain + s.path, start: t(s.startedAt), end: t(s.endedAt), seconds: s.durationMs / 1000,
     })));
   ```

   `await __spike.clear()` empties the queue and the segments, `await show()` lists the closed
   segments, `await __spike.diagnostics()` shows the counters (`restartRecoveries`, `gapCloses`, ...).
   `await __spike.setHeartbeat(false)` / `await __spike.setHeartbeat(true)` turn the 30 s
   heartbeat alarm off or on (see [The heartbeat switch](#the-heartbeat-switch)),
   `await __spike.heartbeatEnabled()` shows the switch, and `await chrome.alarms.getAll()` shows
   whether the `spike-heartbeat` alarm exists.
5. Two Chrome windows of the test profile, side by side, both fully visible:
   - the **test window**, with a `chrome://serviceworker-internals` tab (the resting tab: a
     `chrome://` page never opens a segment) and a `https://example.com/` tab;
   - the **observer window**, with only `chrome://serviceworker-internals`. Find the entry whose
     scope starts with `chrome-extension://<spike id>/`; its *Running Status* shows whether the
     worker is running or stopped. This is where you watch the worker during a scenario, without
     clicking into it (see
     [Watching the worker without waking it](#watching-the-worker-without-waking-it)). Only read
     it; do not click *Inspect*, *Start* or *Stop*.
6. Have a clock with seconds visible (the Windows taskbar clock with seconds, or a phone stopwatch)
   and write down each marked time (T0, T1, ...) as it happens.

### Why DevTools stays closed during a scenario

An open DevTools window on the service worker keeps that worker running: Chrome does not stop a
worker while it is being inspected. With DevTools open, every scenario would run against a worker
that never stops, and would never test what matters in production: the idle, lock, focus or
restart event arriving while the worker is **stopped**, waking it, and the woken worker getting the
boundary right. DevTools is also not a browser window as far as `chrome.windows` is concerned, so
clicking into it is a blur and closes the open segment. So every scenario starts with DevTools
closed and ends its last segment without DevTools, and DevTools is opened only afterwards to read
the results.

### The heartbeat switch

The spike's 30 s heartbeat alarm wakes the worker, and every event resets Chrome's ~30 s
service-worker idle timer. With the heartbeat on, the worker is therefore usually already running
when an idle, lock or focus event arrives, and the scenario does not test the wake path. So:

- **M1, M1b, M2 and M3 run with the heartbeat OFF**, and every key event (the idle event, the lock,
  the unlock, the blur, the click back into Chrome, the minimize, the restore) is triggered only
  after the worker was seen **STOPPED** (see the STOPPED check below).
- **M4, M4b and M5 run with the heartbeat ON**: they test recovery after a quit, a crash or a sleep,
  which closes the open segment at `lastAliveAt`, and `lastAliveAt` is kept fresh by the heartbeat.

The switch is stored in `chrome.storage.local` (`spike.heartbeatEnabled`), so it stays off across
worker restarts and browser restarts until it is turned back on; every worker start creates or
clears the alarm to match it. **Turn it back on with `await __spike.setHeartbeat(true)` when you
are done with M1–M3** (the M4/M5 preparation does this too) and check that
`await __spike.heartbeatEnabled()` returns `true`.

### Watching the worker without waking it

- **Never reload a `chrome://serviceworker-internals` page** during a scenario or a cold-start wait.
  Reloading fires `tabs.onUpdated`, and the spike (which has the `tabs` permission and a top-level
  listener) is woken by it. The page updates *Running Status* live. If it does not, close and
  reopen the observer window only while the worker is allowed to be started, that is **before** the
  cold-start wait begins (doing it later restarts the wait).
- Do not click into the observer window during a scenario: focusing it is a window focus change,
  which wakes the worker (and closes the open segment).
- **Any interaction with Chrome restarts the wait**: clicking a tab, the address bar, the toolbar
  or a link, opening or closing a tab or window, focusing a Chrome window, opening DevTools, and any
  page load. Moving the mouse over the page content is allowed: it produces no extension event, and
  in M2 and M3 it keeps the system from going idle. M1 needs no input at all.
- **STOPPED check** (before each key event in M1–M3): at least **45 s** have passed since the last
  Chrome event or interaction (the worker stops about 30 s after its last event), and the observer
  window shows **STOPPED** for the spike right before you trigger the event. Write down whether it
  did. If it does not show STOPPED within 2 minutes, write "not stopped" for that event: that run
  then does not test the wake path, so repeat the scenario.

### Before M1, M1b, M2 and M3 (cold start, heartbeat off)

1. Open the service worker console, paste the helper, run `await __spike.setHeartbeat(false)` and
   `await __spike.clear()`. Check that `await __spike.heartbeatEnabled()` returns `false` and that
   `await chrome.alarms.getAll()` does not list `spike-heartbeat`.
2. **Close the DevTools window.**
3. In the test window, switch to the `chrome://serviceworker-internals` tab. Make sure the observer
   window shows the spike's entry; this is the last moment opening or reopening it is allowed.
4. Wait, touching nothing in Chrome, and do the STOPPED check. The scenario's first action
   (switching to the `example.com` tab) is then an event that wakes a stopped worker.

### Before M4, M4b and M5 (heartbeat on)

1. Open the service worker console, paste the helper, run `await __spike.setHeartbeat(true)` and
   `await __spike.clear()`. Check that `await __spike.heartbeatEnabled()` returns `true` and that
   `await chrome.alarms.getAll()` lists `spike-heartbeat`.
2. **Close the DevTools window**, switch the test window to its `chrome://serviceworker-internals`
   tab and wait about 10 s. The worker does not have to be stopped: with the heartbeat on it mostly
   keeps running, and these scenarios test recovery, not the wake path. Write "n/a (heartbeat on)"
   in the *Worker stopped?* column.

### After every scenario (reading the results)

1. End the last segment **without DevTools**: switch the test window to its
   `chrome://serviceworker-internals` tab, or press Ctrl+T for a new tab page. That moment is the
   scenario's last marked time. (Alt+Tab to another application also ends it, but coming back to
   Chrome would open a new segment on the test page, so prefer the tab switch.)
2. Only then open `chrome://extensions` in that tab, click *service worker*, paste the helper and
   run the commands the scenario lists. Opening DevTools starts the worker if it is stopped; that is
   expected and does not change the segments already closed.

Pass tolerance: **2 s** for blur and tab events, **5 s** for idle and lock (Chrome polls the idle
state, so detection lags by a few seconds).

## Scenarios

The test page `https://example.com/` is open in a tab of the test window, next to the
`chrome://serviceworker-internals` tab; the observer window is visible next to it. Run M1–M3
(heartbeat off) first, then M4, M4b and M5 (heartbeat on).

### M1. Idle (60 s), heartbeat off

1. Cold start (heartbeat off, above).
2. Switch to the `example.com` tab and click into the page. **T0** = that click.
3. Do not touch the mouse or keyboard from now until T1. Make sure the screen does not lock or
   sleep in that time (set the Windows lock timeout above 5 minutes for this test). The last input
   is the click at T0.
4. Between T0 + 45 s and T0 + 58 s, the observer window must show **STOPPED** (STOPPED check for
   the idle event, which is due about 60 s after T0). Write down whether it did, and the time it
   switches to running (the idle event waking the worker), if you see it.
5. Keep hands off. At least 45 s after the worker woke for the idle event, and not before T0 + 120 s,
   the observer window must show **STOPPED** again (STOPPED check for the return to active). Then
   move the mouse over the page at **T1**. Wait 10 s (moving the mouse is fine).
6. Switch the test window to the `chrome://serviceworker-internals` tab at **T2**. Then read the
   results and run `await show()`.

Expected:

- Segment 1: `example.com/`, start ≈ T0, **end ≈ T0** (the last input; the 60 s of idle detection
  are subtracted), so its duration is about 0 s. Nothing between T0 and T1 counts.
- Segment 2: `example.com/`, start ≈ T1 (the return to active), end ≈ T2.

Pass when both STOPPED checks passed, both segments are present, segment 1 ends within 5 s of T0,
no segment covers the T0 + 5 s … T1 interval, and segment 2 starts within 5 s of T1.

Variant M1b (optional, heartbeat off): play a video in the page and stay hands-off for 90 s. Record
whether Chrome reports idle while media plays (it decides what counts as attention for video).

### M2. Screen lock / unlock, heartbeat off

1. Cold start (heartbeat off), then switch to the `example.com` tab and click into the page at
   **T0**.
2. Keep moving the mouse gently over the page (no clicks), so the system does not go idle. Once the
   STOPPED check passes (at least 45 s after T0), lock the screen (Windows: Win+L) at **T1**.
3. Stay locked for at least 60 s. The worker processes the lock event and should stop again about
   30 s later, with no heartbeat to wake it, but this cannot be watched while the screen is locked:
   write "not observable (locked)" for the unlock's STOPPED check. Unlock at **T2**. If Chrome is
   not the foreground window after unlocking, click into the page and note that time too.
4. Wait 10 s (moving the mouse is fine), switch the test window to the
   `chrome://serviceworker-internals` tab at **T3**. Then read the results and run `await show()`
   and `await __spike.diagnostics()`.

Expected: segment 1 ≈ [T0, T1], no segment covering T1 … T2, segment 2 ≈ [T2, T3].

Pass when the STOPPED check before the lock passed, segment 1 ends within 5 s of T1, segment 2
starts within 5 s of T2, and nothing counts the locked time.

### M3. Real OS window blur (focus to another application), heartbeat off

Place the other application (for example Notepad) so that it does not cover the observer window.

1. Cold start (heartbeat off), then switch to the `example.com` tab and click into the page at
   **T0**.
2. Keep moving the mouse over the page (no clicks). Once the STOPPED check passes (at least 45 s
   after T0), Alt+Tab to the other application at **T1**.
3. Stay in the other application and keep using it (moving the mouse is enough, so the system does
   not go idle); do not touch Chrome. Once the STOPPED check passes (at least 45 s after T1), click
   back into the Chrome page in the test window at **T2**.
4. Keep moving the mouse over the page (no clicks). Once the STOPPED check passes (at least 45 s
   after T2), minimize the test window at **T3** (its minimize button, or Win+Down). Windows may then
   focus another window, including the observer window; that is fine.
5. Keep the test window minimized, without clicking any Chrome window. Once the STOPPED check passes
   (at least 45 s after T3), restore the test window from the taskbar at **T4**.
6. After about 10 s (moving the mouse is fine), switch the test window to the
   `chrome://serviceworker-internals` tab at **T5**. Then read the results and run `await show()`.

Expected: three segments, ≈ [T0, T1], [T2, T3] and [T4, T5]. Nothing between T1 and T2 or between
T3 and T4.

Pass when all four STOPPED checks passed and every boundary is within 2 s of the marked time.

**When M1–M3 are done, run `await __spike.setHeartbeat(true)`** (the next preparation step does it
anyway; do not leave the profile with the heartbeat off).

### M4. Browser restart (quit and relaunch), heartbeat on

1. Prepare (heartbeat on, above). Switch to the `example.com` tab and **reload it (F5)**:
   `__spike.clear()` empties the queue but keeps the per-tab marks, and the tab already holds the
   visit to `example.com/`, so without a new load it would produce no `page_visited` in this run.
   The reload is a new load of a tab whose mark is not `recovered`, so it is recorded. Exception: if
   Chrome restored this tab at startup (M4b right after M4, or any rerun after a restart), its mark
   may be `recovered`, and its next load of the same page is then treated as the late event of that
   recovered visit and skipped once. In that case open `https://example.com/` in a **new tab**
   (Ctrl+T) instead of reloading. Then click into the page, and in the same tab go to
   `https://example.org/` (type it in the address bar). **T0** = pressing Enter.
2. Stay on the page (move the mouse now and then so it does not go idle) for at least 45 s, so at
   least one 30 s heartbeat runs. Do not open DevTools.
3. Quit Chrome completely at **T1** (Chrome menu > Exit). Check Task Manager: no `chrome.exe` left
   for this profile (turn off *Continue running background apps* if needed).
4. Wait at least 2 minutes. Start Chrome with the same profile at **T2**. Read the results (open
   the service worker console from `chrome://extensions`) and run `await show()`,
   `await __spike.diagnostics()`, `await __spike.heartbeatEnabled()` (must still be `true`) and
   `(await __spike.queueDump()).filter((e) => e.type === "page_visited").map((e) => e.domain + e.path)`.

Expected:

- The `example.org/` segment is closed with start ≈ T0 and **T1 − 35 s ≤ end ≤ T1 + 2 s**: it ends
  at the shutdown itself (if the worker processed the closing events) or at the last heartbeat
  before it (`restartRecoveries` is then 1). It never extends into T1 … T2.
- The page_visited list holds `example.com/` (from the reload or the new tab) and `example.org/`
  once each. If Chrome restores tabs on startup, the restored pages appear as new visits; note it.

Pass when the `example.org/` segment exists, starts within 2 s of T0, ends within
[T1 − 35 s, T1 + 2 s], no segment covers any part of T1 + 2 s … T2, and `example.com/` and
`example.org/` each appear exactly once in the page_visited list (not counting visits from
restored tabs after T2).

Variant M4b, crash (heartbeat on): repeat, but end Chrome at T1 with Task Manager (*End task* on
Chrome). Switching to Task Manager moves focus away from Chrome first, so mark **T1** at that
switch: the blur normally closes the segment there, and the heartbeat recovery
(`restartRecoveries` = 1) only runs if that blur was not processed before the kill. Same
expectations and pass line.

### M5 (optional). System sleep, heartbeat on

1. Prepare (heartbeat on), then switch to the `example.com` tab and click into the page at **T0**.
2. After about 10 s, put the machine to sleep at **T1**. Leave it asleep for at least 3 minutes.
3. Wake it at **T2** and unlock if asked. If Chrome is not the foreground window, click into the
   page.
4. Wait 10 s, switch the test window to the `chrome://serviceworker-internals` tab at **T3**. Then
   read the results and run `await show()` and `await __spike.diagnostics()`.

Expected: the first segment ends at the sleep itself or at the last heartbeat before it (within
35 s before T1), closed by the lock rule or by the gap recovery (`gapCloses` = 1); the sleep time
never counts. A second segment ≈ [T2, T3] (or from the unlock, if Windows locked on wake).

Pass when the first segment starts within 2 s of T0 and ends within [T1 − 35 s, T1 + 2 s], no
segment covers any part of T1 + 2 s … T2, and the second segment starts within 5 s of T2 (or of
the unlock).

## Results

Fill in one row per run. Record times as `hh:mm:ss.s` and differences in seconds; do not paste
real browsing data. *Heartbeat* is the switch during the run (`off` for M1–M3, `on` for M4, M4b,
M5). *Worker stopped?* lists the STOPPED check before each key event (for example
"T1 yes, T2 not observable (locked)"), or "n/a (heartbeat on)".

| Scenario | Date | OS / Chrome version | Heartbeat | Worker stopped? | Marked times | Observed segments (start–end, s) | Max boundary error (s) | Pass? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M1 idle | | | off | | | | | | |
| M1b idle with video | | | off | | | | | | |
| M2 lock / unlock | | | off | | | | | | |
| M3 blur (Alt+Tab, minimize) | | | off | | | | | | |
| M4 restart (quit) | | | on | n/a | | | | | |
| M4b restart (crash) | | | on | n/a | | | | | |
| M5 sleep (optional) | | | on | n/a | | | | | |

When done, make sure the heartbeat is back on (`await __spike.heartbeatEnabled()` returns `true`),
then remove the spike from `chrome://extensions` (this deletes its IndexedDB data and its
`chrome.storage` values) and update the "Manual verification" section of ADR 0002 with the
outcome.
