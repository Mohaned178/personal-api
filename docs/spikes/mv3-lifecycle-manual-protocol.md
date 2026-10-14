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
3. Only visit test pages such as `https://example.com/` and `https://example.org/`. The prototype
   keeps domain + path locally in IndexedDB and sends nothing, but results get pasted into this
   public repo, so do not record real browsing.
4. Open the service worker console: on `chrome://extensions`, click *service worker* under the
   spike. Keep this DevTools window open for the whole session, and paste this helper once:

   ```js
   const t = (ms) => new Date(ms).toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 1 });
   const show = async () =>
     console.table((await __spike.segments()).map((s) => ({
       path: s.domain + s.path, start: t(s.startedAt), end: t(s.endedAt), seconds: s.durationMs / 1000,
     })));
   ```

   `await __spike.clear()` empties the queue and the segments, `await show()` lists the closed
   segments, `await __spike.diagnostics()` shows the counters (`restartRecoveries`, `gapCloses`, ...).
5. Have a clock with seconds visible (the Windows taskbar clock with seconds, or a phone stopwatch)
   and write down each marked time (T0, T1, ...) as it happens.

**Important:** the DevTools window is not a browser window as far as `chrome.windows` is concerned,
so clicking into it moves focus away from the page and **closes the open segment** (that is the
blur rule working). Always click back into the page window to start a scenario, and treat the moment
you click into DevTools to read the results as the end of the last segment.

Pass tolerance: **2 s** for blur and tab events, **5 s** for idle and lock (Chrome polls the idle
state, so detection lags by a few seconds).

## Scenarios

### M1. Idle (60 s)

1. In DevTools: `await __spike.clear()`.
2. Click into the page window on `https://example.com/`. **T0** = that click.
3. Do not touch the mouse or keyboard for at least 90 s. Make sure the screen does not lock or
   sleep in that time (set the Windows lock timeout above 5 minutes for this test). The last input
   is the click at T0.
4. Move the mouse over the page at **T1** (at least 90 s after T0). Wait 10 s.
5. Click into DevTools at **T2** and run `await show()`.

Expected:

- Segment 1: `example.com/`, start ≈ T0, **end ≈ T0** (the last input; the 60 s of idle detection
  are subtracted), so its duration is about 0 s. Nothing between T0 and T1 counts.
- Segment 2: `example.com/`, start ≈ T1 (the return to active), end ≈ T2.

Pass when both segments are present, segment 1 ends within 5 s of T0, no segment covers the
T0 + 5 s … T1 interval, and segment 2 starts within 5 s of T1.

Variant M1b (optional): play a video in the page and stay hands-off for 90 s. Record whether Chrome
reports idle while media plays (it decides what counts as attention for video).

### M2. Screen lock / unlock

1. `await __spike.clear()`, then click into the page window on `https://example.com/` at **T0**.
2. After about 10 s, lock the screen (Windows: Win+L) at **T1**.
3. Wait at least 30 s, unlock at **T2**. If Chrome is not the foreground window after unlocking,
   click into the page.
4. Wait 10 s, click into DevTools at **T3**, run `await show()` and `await __spike.diagnostics()`.

Expected: segment 1 ≈ [T0, T1], no segment covering T1 … T2, segment 2 ≈ [T2, T3].

Pass when segment 1 ends within 5 s of T1, segment 2 starts within 5 s of T2, and nothing counts
the locked time.

### M3. Real OS window blur (focus to another application)

1. `await __spike.clear()`, click into the page window on `https://example.com/` at **T0**.
2. After about 10 s, Alt+Tab to another application (for example Notepad) at **T1**.
3. Wait 20 s, click back into the Chrome page window at **T2**.
4. After about 10 s, minimize the Chrome window at **T3**; wait 10 s; restore it at **T4**.
5. After about 10 s, click into DevTools at **T5** and run `await show()`.

Expected: three segments, ≈ [T0, T1], [T2, T3] and [T4, T5]. Nothing between T1 and T2 or between
T3 and T4.

Pass when every boundary is within 2 s of the marked time.

### M4. Browser restart (quit and relaunch)

1. `await __spike.clear()`. Open `https://example.com/` and then `https://example.org/` in the same
   tab, and click into the page window at **T0**.
2. Stay on the page (move the mouse now and then so it does not go idle) for at least 45 s, so at
   least one 30 s heartbeat runs.
3. Note the queue size in DevTools first if you like (`(await __spike.queueDump()).length`), then
   click back into the page and quit Chrome completely at **T1** (menu > Exit). Check Task Manager:
   no `chrome.exe` left for this profile (turn off *Continue running background apps* if needed).
4. Wait at least 2 minutes. Start Chrome with the same profile at **T2**, open the service worker
   console again and run `await show()`, `await __spike.diagnostics()` and
   `(await __spike.queueDump()).filter((e) => e.type === "page_visited").map((e) => e.domain + e.path)`.

Expected:

- The `example.org/` segment is closed with start ≈ T0 and **T1 − 35 s ≤ end ≤ T1 + 2 s**: it ends
  at the shutdown itself (if the worker processed the closing events) or at the last heartbeat
  before it (`restartRecoveries` is then 1). It never extends into T1 … T2.
- The page_visited list still holds `example.com/` and `example.org/` once each. If Chrome restores
  tabs on startup, the restored pages appear as new visits; note it.

Variant M4b, crash: repeat, but end Chrome at T1 with Task Manager (*End task* on Chrome). Same
expectations; this one always goes through the heartbeat recovery.

### M5 (optional). System sleep

Focus `https://example.com/`, then put the machine to sleep for at least 3 minutes and wake it.
Expected: the segment ends at the last heartbeat before the sleep (within 35 s before it) and
`gapCloses` or the lock rule closes it; the sleep time never counts.

## Results

Fill in one row per run. Record times as `hh:mm:ss.s` and differences in seconds; do not paste
real browsing data.

| Scenario | Date | OS / Chrome version | Marked times | Observed segments (start–end, s) | Max boundary error (s) | Pass? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M1 idle | | | | | | | |
| M1b idle with video | | | | | | | |
| M2 lock / unlock | | | | | | | |
| M3 blur (Alt+Tab, minimize) | | | | | | | |
| M4 restart (quit) | | | | | | | |
| M4b restart (crash) | | | | | | | |
| M5 sleep (optional) | | | | | | | |

When done, remove the spike from `chrome://extensions` (this deletes its IndexedDB data) and
update the "Manual verification" section of ADR 0002 with the outcome.
