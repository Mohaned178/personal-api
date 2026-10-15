import { describe, expect, it } from "vitest";
import { SESSION_IDLE_TIMEOUT_MS } from "../../lib/capture";
import { advance, denyAll, MINUTE, newSim, SECOND, setupSimTests, T0 } from "./support/sim";

// M2-04: browser.session_started / browser.session_ended. ADR 0002 does not cover them, so only
// what PLAN §4 and the contracts' reasons say is pinned here:
//   - startup:   the first start of a new browser session;
//   - recovered: a session left open by a previous browser session is closed after the fact, at
//                the last moment the browser was known alive;
//   - idle:      the session ends after 30 minutes idle, never before;
//   - lock:      a screen lock ends it.
// Everything else (resume, shutdown, blur) is the implementation's call and is not asserted.

setupSimTests();

describe("sessions", () => {
  it("starts a session with reason startup on the first start of a browser session, once", async () => {
    const sim = newSim();
    await sim.start();
    expect(sim.sessionEvents()).toEqual([{ kind: "started", reason: "startup", at: T0 }]);
    await sim.start();
    advance(5 * SECOND);
    await sim.heartbeat();
    expect(sim.sessionEvents()).toHaveLength(1);
  });

  it("does not start another session when only the background was killed and restarted", async () => {
    const sim = newSim();
    await sim.start();
    advance(40 * SECOND);
    sim.restartWorker();
    await sim.start();
    advance(40 * SECOND);
    sim.restartWorker();
    await sim.start();
    expect(sim.sessionEvents().map((e) => e.kind)).toEqual(["started"]);
  });

  it("closes a session left open by the previous browser session as recovered, at the last known alive time, before starting the new one", async () => {
    const sim = newSim();
    await sim.start();
    await sim.beats(1); // last step at 30 s
    advance(10 * MINUTE); // the browser was closed
    sim.restartWorker({ browserSession: true });
    await sim.start();
    expect(sim.sessionEvents()).toEqual([
      { kind: "started", reason: "startup", at: T0 },
      { kind: "ended", reason: "recovered", at: T0 + 30 * SECOND },
      { kind: "started", reason: "startup", at: T0 + 30 * SECOND + 10 * MINUTE },
    ]);
  });

  it("ends the session with reason lock when the screen locks", async () => {
    const sim = newSim();
    await sim.start();
    advance(20 * SECOND);
    await sim.setIdle("locked");
    const ended = sim.sessionEvents().filter((e) => e.kind === "ended");
    expect(ended).toEqual([{ kind: "ended", reason: "lock", at: T0 + 20 * SECOND }]);
  });

  it("does not end the session when idle lasts less than 30 minutes", async () => {
    const sim = newSim();
    await sim.start();
    advance(100 * SECOND);
    await sim.setIdle("idle");
    advance(20 * MINUTE);
    await sim.heartbeat();
    advance(5 * MINUTE);
    await sim.setIdle("active");
    advance(MINUTE);
    await sim.heartbeat();
    expect(sim.sessionEvents().filter((e) => e.kind === "ended")).toEqual([]);
  });

  it("ends the session with reason idle once 30 minutes of idle have passed, on a heartbeat, timed 30 minutes after the last input", async () => {
    const sim = newSim();
    await sim.start();
    advance(100 * SECOND);
    await sim.setIdle("idle"); // the last input was at 40 s
    const idleReportedAt = T0 + 100 * SECOND;
    advance(28 * MINUTE);
    await sim.heartbeat();
    expect(sim.sessionEvents().filter((e) => e.kind === "ended")).toEqual([]);
    advance(4 * MINUTE);
    await sim.heartbeat();
    const ended = sim.sessionEvents().filter((e) => e.kind === "ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.reason).toBe("idle");
    // 30 minutes after the last input (40 s), or after the idle report (100 s): never earlier or
    // later than that.
    expect(ended[0]?.at).toBeGreaterThanOrEqual(
      idleReportedAt - 60 * SECOND + SESSION_IDLE_TIMEOUT_MS,
    );
    expect(ended[0]?.at).toBeLessThanOrEqual(idleReportedAt + SESSION_IDLE_TIMEOUT_MS);
  });

  it("ends the idle session when the user returns after more than 30 minutes, timed at the end of the idle period and not at the return", async () => {
    const sim = newSim();
    await sim.start();
    advance(100 * SECOND);
    await sim.setIdle("idle");
    const idleReportedAt = T0 + 100 * SECOND;
    advance(45 * MINUTE);
    await sim.setIdle("active");
    const events = sim.sessionEvents();
    const ended = events.filter((e) => e.kind === "ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.reason).toBe("idle");
    expect(ended[0]?.at).toBeLessThanOrEqual(idleReportedAt + SESSION_IDLE_TIMEOUT_MS);
    expect(ended[0]?.at).toBeGreaterThanOrEqual(
      idleReportedAt - 60 * SECOND + SESSION_IDLE_TIMEOUT_MS,
    );
  });

  it("emits a single session_ended for one idle period however many heartbeats follow", async () => {
    const sim = newSim();
    await sim.start();
    advance(100 * SECOND);
    await sim.setIdle("idle");
    for (let i = 0; i < 12; i++) {
      advance(5 * MINUTE);
      await sim.heartbeat();
    }
    expect(sim.sessionEvents().filter((e) => e.kind === "ended")).toHaveLength(1);
  });

  it("never emits two session_started or two session_ended in a row", async () => {
    const sim = newSim();
    await sim.start();
    await sim.setIdle("locked");
    await sim.setIdle("active");
    advance(40 * MINUTE);
    await sim.setIdle("idle");
    advance(40 * MINUTE);
    await sim.heartbeat();
    await sim.setIdle("active");
    await sim.setIdle("locked");
    await sim.setIdle("locked");
    const kinds = sim.sessionEvents().map((e) => e.kind);
    for (let i = 1; i < kinds.length; i++) expect(kinds[i]).not.toBe(kinds[i - 1]);
    expect(kinds[0]).toBe("started");
  });

  it("emits no session event while the gate denies (positive control: it does once allowed)", async () => {
    const sim = newSim({ gate: denyAll });
    await sim.start();
    await sim.setIdle("locked");
    await sim.setIdle("active");
    expect(sim.sessionEvents()).toEqual([]);
    sim.gate = { allows: () => true };
    sim.restartWorker({ browserSession: true });
    await sim.start();
    expect(sim.sessionEvents().some((e) => e.kind === "started")).toBe(true);
  });
});
