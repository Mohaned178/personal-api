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
   Note the spike's extension id shown there.
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
5. In the test window, keep one tab open on `chrome://serviceworker-internals` and find the entry
   whose scope starts with `chrome-extension://<spike id>/`. Its *Running Status* shows whether the
   worker is running or stopped (reload the page to refresh it). Only read it there; do not click
   *Inspect*, *Start* or *Stop*.
6. Have a clock with seconds visible (the Windows taskbar clock with seconds, or a phone stopwatch)
   and write down each marked time (T0, T1, ...) as it happens.

### Why DevTools stays closed during a scenario

An open DevTools window on the service worker keeps that worker running: Chrome does not stop a
worker while it is being inspected. With DevTools open, every scenario would run against a worker
that never stops, and would never test what matters in production: the idle, lock, focus or
restart event arriving while the worker is **stopped**, waking it, and the woken worker getting the
boundary right. DevTools is also not a browser window as far as `chrome.windows` is concerned, so
clicking into it is a blur and closes the open segment. So every scenario starts from a stopped
worker and ends its last segment without DevTools, and DevTools is opened only afterwards to read
the results.

### Before every scenario (cold start)

1. Open the service worker console, paste the helper, run `await __spike.clear()`.
2. **Close the DevTools window.**
3. Switch to the `chrome://serviceworker-internals` tab (a `chrome://` page never opens a segment)
   and wait, without touching the test pages, until the spike's *Running Status* shows **STOPPED**.
   That takes at least 30 s after the worker's last event. The 30 s heartbeat alarm wakes the worker
   now and then, so the status may go back to running for a moment; start the scenario while it
   shows STOPPED. If it never shows STOPPED within 2 minutes, run the scenario anyway and write
   "not stopped" in the results table: that run then does not test the wake path.
4. The scenario's first action (switching to the test page tab) is the event that wakes the worker.

### After every scenario (reading the results)

1. End the last segment **without DevTools**: switch to the `chrome://serviceworker-internals` tab,
   or press Ctrl+T for a new tab page. That moment is the scenario's last marked time. (Alt+Tab to
   another application also ends it, but coming back to Chrome would open a new segment on the test
   page, so prefer the tab switch.)
2. Only then open `chrome://extensions` in that tab, click *service worker*, paste the helper and
   run the commands the scenario lists. Opening DevTools starts the worker if it is stopped; that is
   expected and does not change the segments already closed.

Pass tolerance: **2 s** for blur and tab events, **5 s** for idle and lock (Chrome polls the idle
state, so detection lags by a few seconds).

## Scenarios

The test page `https://example.com/` is open in a tab of the test window, next to the
`chrome://serviceworker-internals` tab.

### M1. Idle (60 s)

1. Cold start (above).
2. Switch to the `example.com` tab and click into the page. **T0** = that click.
3. Do not touch the mouse or keyboard for at least 90 s. Make sure the screen does not lock or
   sleep in that time (set the Windows lock timeout above 5 minutes for this test). The last input
   is the click at T0. The worker stops during this wait; the idle event has to wake it.
4. Move the mouse over the page at **T1** (at least 90 s after T0). Wait 10 s.
5. Switch to the `chrome://serviceworker-internals` tab at **T2**. Then read the results and run
   `await show()`.

Expected:

- Segment 1: `example.com/`, start ≈ T0, **end ≈ T0** (the last input; the 60 s of idle detection
  are subtracted), so its duration is about 0 s. Nothing between T0 and T1 counts.
- Segment 2: `example.com/`, start ≈ T1 (the return to active), end ≈ T2.

Pass when both segments are present, segment 1 ends within 5 s of T0, no segment covers the
T0 + 5 s … T1 interval, and segment 2 starts within 5 s of T1.

Variant M1b (optional): play a video in the page and stay hands-off for 90 s. Record whether Chrome
reports idle while media plays (it decides what counts as attention for video).

### M2. Screen lock / unlock

1. Cold start, then switch to the `example.com` tab and click into the page at **T0**.
2. After about 10 s, lock the screen (Windows: Win+L) at **T1**.
3. Wait at least 30 s (the worker can stop again while locked), unlock at **T2**. If Chrome is not
   the foreground window after unlocking, click into the page.
4. Wait 10 s, switch to the `chrome://serviceworker-internals` tab at **T3**. Then read the results
   and run `await show()` and `await __spike.diagnostics()`.

Expected: segment 1 ≈ [T0, T1], no segment covering T1 … T2, segment 2 ≈ [T2, T3].

Pass when segment 1 ends within 5 s of T1, segment 2 starts within 5 s of T2, and nothing counts
the locked time.

### M3. Real OS window blur (focus to another application)

1. Cold start, then switch to the `example.com` tab and click into the page at **T0**.
2. After about 10 s, Alt+Tab to another application (for example Notepad) at **T1**.
3. Wait at least 35 s (so the worker can stop), checking nothing in Chrome, then click back into
   the Chrome page at **T2**.
4. After about 10 s, minimize the Chrome window at **T3**; wait at least 35 s; restore it at
   **T4**.
5. After about 10 s, switch to the `chrome://serviceworker-internals` tab at **T5**. Then read the
   results and run `await show()`.

Expected: three segments, ≈ [T0, T1], [T2, T3] and [T4, T5]. Nothing between T1 and T2 or between
T3 and T4.

Pass when every boundary is within 2 s of the marked time.

### M4. Browser restart (quit and relaunch)

1. Cold start, then switch to the `example.com` tab, click into the page, and in the same tab go to
   `https://example.org/` (type it in the address bar). **T0** = pressing Enter.
2. Stay on the page (move the mouse now and then so it does not go idle) for at least 45 s, so at
   least one 30 s heartbeat runs. Do not open DevTools.
3. Quit Chrome completely at **T1** (Chrome menu > Exit). Check Task Manager: no `chrome.exe` left
   for this profile (turn off *Continue running background apps* if needed).
4. Wait at least 2 minutes. Start Chrome with the same profile at **T2**. Read the results (open
   the service worker console from `chrome://extensions`) and run `await show()`,
   `await __spike.diagnostics()` and
   `(await __spike.queueDump()).filter((e) => e.type === "page_visited").map((e) => e.domain + e.path)`.

Expected:

- The `example.org/` segment is closed with start ≈ T0 and **T1 − 35 s ≤ end ≤ T1 + 2 s**: it ends
  at the shutdown itself (if the worker processed the closing events) or at the last heartbeat
  before it (`restartRecoveries` is then 1). It never extends into T1 … T2.
- The page_visited list holds `example.com/` and `example.org/` once each. If Chrome restores tabs
  on startup, the restored pages appear as new visits; note it.

Pass when the `example.org/` segment exists, starts within 2 s of T0, ends within
[T1 − 35 s, T1 + 2 s], no segment covers any part of T1 + 2 s … T2, and `example.com/` and
`example.org/` each appear exactly once in the page_visited list (not counting visits from
restored tabs after T2).

Variant M4b, crash: repeat, but end Chrome at T1 with Task Manager (*End task* on Chrome).
Switching to Task Manager moves focus away from Chrome first, so mark **T1** at that switch: the
blur normally closes the segment there, and the heartbeat recovery (`restartRecoveries` = 1) only
runs if that blur was not processed before the kill. Same expectations and pass line.

### M5 (optional). System sleep

1. Cold start, then switch to the `example.com` tab and click into the page at **T0**.
2. After about 10 s, put the machine to sleep at **T1**. Leave it asleep for at least 3 minutes.
3. Wake it at **T2** and unlock if asked. If Chrome is not the foreground window, click into the
   page.
4. Wait 10 s, switch to the `chrome://serviceworker-internals` tab at **T3**. Then read the results
   and run `await show()` and `await __spike.diagnostics()`.

Expected: the first segment ends at the sleep itself or at the last heartbeat before it (within
35 s before T1), closed by the lock rule or by the gap recovery (`gapCloses` = 1); the sleep time
never counts. A second segment ≈ [T2, T3] (or from the unlock, if Windows locked on wake).

Pass when the first segment starts within 2 s of T0 and ends within [T1 − 35 s, T1 + 2 s], no
segment covers any part of T1 + 2 s … T2, and the second segment starts within 5 s of T2 (or of
the unlock).

## Results

Fill in one row per run. Record times as `hh:mm:ss.s` and differences in seconds; do not paste
real browsing data. *Worker stopped?* is whether serviceworker-internals showed STOPPED right
before the scenario started (cold start step 3).

| Scenario | Date | OS / Chrome version | Worker stopped? | Marked times | Observed segments (start–end, s) | Max boundary error (s) | Pass? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M1 idle | | | | | | | | |
| M1b idle with video | | | | | | | | |
| M2 lock / unlock | | | | | | | | |
| M3 blur (Alt+Tab, minimize) | | | | | | | | |
| M4 restart (quit) | | | | | | | | |
| M4b restart (crash) | | | | | | | | |
| M5 sleep (optional) | | | | | | | | |

When done, remove the spike from `chrome://extensions` (this deletes its IndexedDB data) and
update the "Manual verification" section of ADR 0002 with the outcome.
