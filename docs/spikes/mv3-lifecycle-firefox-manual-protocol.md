# Spike C manual protocol (Firefox): idle, lock, real window blur, browser restart

Part of M2-00b (see the Firefox section of `docs/adr/0002-mv3-state-persistence.md`). It is the
Firefox sibling of `docs/spikes/mv3-lifecycle-manual-protocol.md` (Spike A, Chrome): same
prototype, same scenarios, same pass lines, with the Firefox differences spelled out here. Read the
Chrome protocol's sections "Why DevTools stays closed during a scenario" and "The heartbeat switch"
first: both apply unchanged, with "service worker" read as "event page" and
`chrome.*` as `browser.*`.

The automated Firefox spec (`apps/e2e/tests/spike-mv3-firefox.spec.ts`) covers forced background
suspensions, tab switches, a headless approximation of window blur and a profile relaunch with the
add-on re-installed as a temporary add-on. It cannot produce real OS input idleness, a screen lock,
focus moving to another application, or a real quit of a Firefox that has the add-on installed
permanently. Those are checked by hand with the steps below.

## What is different on Firefox (read before running)

- **The background is an event page, not a service worker.** Firefox suspends it after
  `extensions.background.idle.timeout` (30 s by default) without an event, the same order of
  magnitude as Chrome's ~30 s worker idle timeout, so the 45 s STOPPED check stays.
- **Firefox never reports `locked`.** Firefox's `idle` API only knows `active` and `idle` (read in
  Firefox 158's own source, `ext-idle.js`; not measured). A screen lock is therefore expected to
  show up only as `idle`, 60 s after the last input, unless locking the screen also takes focus away
  from the Firefox window (a `windows.onFocusChanged` event). Which of the two closes the segment is
  exactly what F2 records.
- **Temporary add-ons disappear when Firefox quits.** Release Firefox only installs signed add-ons
  permanently. F1–F3 can use a temporary add-on; F4/F4b need the add-on to still be installed after
  the restart (see Setup step 2).

## Setup

1. Build the prototype: `pnpm --filter @personal-api/spike-mv3-lifecycle build` (builds
   `.output/chrome-mv3` and `.output/firefox-mv3`).
2. Use a **separate, empty Firefox profile** (`firefox -P`, *Create Profile*), not your everyday
   one. Install the spike:
   - **For F1–F3** any Firefox works: open `about:debugging#/runtime/this-firefox`, *Load Temporary
     Add-on…*, and select `spikes/mv3-lifecycle/.output/firefox-mv3/manifest.json`.
   - **For F4 and F4b** the add-on must survive a restart. Either use Firefox Developer Edition or
     Nightly with `xpinstall.signatures.required` set to `false` in `about:config` and install a zip
     of the build from `about:addons` (gear menu, *Install Add-on From File…*; make the zip with
     `pnpm --filter @personal-api/spike-mv3-lifecycle exec wxt zip -b firefox --mv3`), or a build
     signed by AMO as unlisted. Mozilla documents that release and Beta builds ignore that pref
     (documentation, not checked here). If neither is available, write "not run (no permanent
     install)" for F4/F4b.
   Install the spike **before** opening any test page, so every test tab's first load is recorded by
   its own event.
3. Only visit test pages such as `https://example.com/` and `https://example.org/`. Results get
   pasted into this public repo, so do not record real browsing.
4. The background console: on `about:debugging#/runtime/this-firefox`, click *Inspect* on the spike.
   This opens DevTools on the event page, and an attached DevTools keeps the page from being
   suspended (Firefox's termination code skips an extension with DevTools attached), so it is only
   opened to prepare and to read results, never during a scenario. Paste the helper from the Chrome
   protocol (Setup step 4) in its console. `await __spike.setHeartbeat(false|true)`,
   `await __spike.heartbeatEnabled()`, `await __spike.clear()`, `await __spike.diagnostics()` work
   the same; list alarms with `await browser.alarms.getAll()`.
5. Two Firefox windows of the test profile, side by side, both fully visible:
   - the **test window**, with an `about:robots` tab (the resting tab: a non-http(s) page never opens
     a segment) and a `https://example.com/` tab;
   - the **observer window**, with only `about:debugging#/runtime/this-firefox`. The spike's card
     shows the background script's status (running or stopped) and a *Terminate Background Script*
     button. Only read it; do not click *Inspect* or *Terminate* during a scenario. Before the first
     scenario, check that the status changes by itself about 30 s after the last event (the
     protocol relies on it updating live). If it does not, write that down: the STOPPED checks
     cannot be done and F1–F3 then do not test the wake path.
6. A clock with seconds visible; write down each marked time (T0, T1, ...) as it happens.

### Watching the background without waking it

Same rules as the Chrome protocol: never reload the `about:debugging` page during a scenario (a
reload is a `tabs.onUpdated` event, and the spike has a top-level listener for it), never click into
the observer window during a scenario (a window focus change), and any interaction with Firefox
restarts the wait. **STOPPED check**: at least 45 s since the last Firefox event or interaction, and
the observer shows the background as stopped right before the key event.

### Before F1, F1b, F2 and F3 (cold start, heartbeat off)

1. Open the background console (Inspect), paste the helper, run `await __spike.setHeartbeat(false)`
   and `await __spike.clear()`. Check `await __spike.heartbeatEnabled()` is `false` and
   `await browser.alarms.getAll()` does not list `spike-heartbeat`.
2. **Close the DevTools window.**
3. In the test window, switch to the `about:robots` tab.
4. Wait, touching nothing in Firefox, and do the STOPPED check.

### Before F4, F4b and F5 (heartbeat on)

1. Open the background console, run `await __spike.setHeartbeat(true)` and `await __spike.clear()`.
   Check that the alarm is listed.
2. **Close the DevTools window**, switch the test window to `about:robots`, wait about 10 s. Write
   "n/a (heartbeat on)" in the *Background stopped?* column.

### After every scenario

1. End the last segment without DevTools: switch the test window to its `about:robots` tab. That is
   the scenario's last marked time.
2. Only then open the background console from `about:debugging` and run the commands the scenario
   lists.

Pass tolerance: **2 s** for blur and tab events, **5 s** for idle and lock.

## Scenarios

### F1. Idle (60 s), heartbeat off

Same steps, expectations and pass line as Chrome's M1, with `about:robots` as the resting tab.
Expected: segment 1 ends ≈ T0 (the idle rule subtracts the 60 s detection interval), segment 2
starts ≈ T1.

Variant F1b (optional): play a video in the page and stay hands-off for 90 s. Record whether
Firefox reports idle while media plays.

### F2. Screen lock / unlock, heartbeat off

1. Cold start, switch to the `example.com` tab and click into the page at **T0**.
2. Keep moving the mouse over the page (no clicks). Once the STOPPED check passes (at least 45 s
   after T0), lock the screen (Windows: Win+L) at **T1**.
3. Stay locked for at least **90 s** (longer than the 60 s idle interval, since Firefox has no
   `locked` state). Unlock at **T2**; if Firefox is not the foreground window, click into the page
   and note that time too.
4. Wait 10 s (moving the mouse is fine), switch the test window to `about:robots` at **T3**. Read
   the results: `await show()` and `await __spike.diagnostics()`.

Expected: segment 1 ≈ [T0, T1], no segment covering T1 … T2, segment 2 ≈ [T2, T3]. Record which
signal ended segment 1: if it ends within 2 s of T1, the lock was seen as a focus loss; if it ends
at the last mouse movement before T1 (≈ T1) only after the idle event, it was the idle rule. Both
pass.

Pass when the STOPPED check before the lock passed, segment 1 ends within 5 s of T1, segment 2
starts within 5 s of T2, and nothing counts the locked time.

Variant F2b, **short lock** (heartbeat off): as F2, but unlock after about **30 s**, before the
idle interval elapses. Record whether segment 1 ends at T1 (focus loss on lock) or spans the lock
(no signal at all). A spanning segment is a known Firefox difference to record in ADR 0002 (the
locked time, at most 60 s, would count as attention), not a failure of the prototype.

### F3. Real OS window blur (focus to another application), heartbeat off

Same steps, expectations and pass line as Chrome's M3 (Alt+Tab away at T1, click back at T2,
minimize at T3, restore at T4, end at T5), with `about:robots` as the resting tab.

In addition, after T5, check what `browser.windows.getLastFocused()` returns while another
application has focus (the level-triggered focus check needs `focused: false` there). Opening
the console and clicking away would itself be focus changes, so do not try to read it by hand:
in the background console run

```js
setTimeout(async () => console.log(JSON.stringify(await browser.windows.getLastFocused())), 5000)
```

then within 5 s switch to another application (Alt+Tab) and wait there about 10 s. Switch back
and read the logged line in the console. Record its `focused` value in the Notes column. (This
`setTimeout` is only a one-off probe typed into the console, not prototype code.)

### F4. Browser restart (quit and relaunch), heartbeat on (permanent install only)

Same steps, expectations and pass line as Chrome's M4, with Firefox's menu > *Quit* (Ctrl+Shift+Q)
at T1, and Task Manager showing no `firefox.exe` for this profile afterwards. Also record whether
the background started by itself after the relaunch (the observer's status, without any click),
because the prototype only listens to `runtime.onStartup` to be started at browser start.

Variant F4b, crash: end Firefox at T1 with Task Manager (*End task*), marking T1 at the switch to
Task Manager, as in Chrome's M4b.

### F5 (optional). System sleep, heartbeat on

Same as Chrome's M5.

## Results

| Scenario | Date | OS / Firefox version | Heartbeat | Background stopped? | Marked times | Observed segments (start–end, s) | Max boundary error (s) | Pass? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1 idle | | | off | | | | | | |
| F1b idle with video | | | off | | | | | | |
| F2 lock / unlock (≥ 90 s) | | | off | | | | | | which signal ended segment 1 |
| F2b short lock (~30 s) | | | off | | | | | | spans the lock? |
| F3 blur (Alt+Tab, minimize) | | | off | | | | | | getLastFocused while away |
| F4 restart (quit) | | | on | n/a | | | | | background started by itself? |
| F4b restart (crash) | | | on | n/a | | | | | |
| F5 sleep (optional) | | | on | n/a | | | | | |

When done, turn the heartbeat back on, remove the spike from `about:addons` (or let the temporary
add-on go with the next quit), and summarise the results in ADR 0002's "Manual verification
(Firefox)" table (in its Firefox (Spike C) section).
