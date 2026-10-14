import { describe, expect, it } from "vitest";
import { HEARTBEAT_CLIENT_VERSION_MAX, heartbeatRequestSchema } from "./ingest.js";

const valid = { queueDepth: 3, oldestQueuedAgeMs: 1500, droppedCount: 0, clientVersion: "0.1.0" };

describe("heartbeatRequestSchema", () => {
  it("accepts a valid heartbeat", () => {
    expect(heartbeatRequestSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ["unknown key", { ...valid, userId: "x" }],
    ["missing field", { queueDepth: 1, oldestQueuedAgeMs: 1, droppedCount: 1 }],
    ["negative", { ...valid, queueDepth: -1 }],
    ["fraction", { ...valid, droppedCount: 1.5 }],
    ["string number", { ...valid, queueDepth: "1" }],
    ["unsafe integer", { ...valid, oldestQueuedAgeMs: 2 ** 60 }],
    ["empty version", { ...valid, clientVersion: "" }],
    ["long version", { ...valid, clientVersion: "x".repeat(HEARTBEAT_CLIENT_VERSION_MAX + 1) }],
    ["control char", { ...valid, clientVersion: "1.0\n" }],
    ["lone surrogate", { ...valid, clientVersion: "1.\ud800" }],
    ["null byte", { ...valid, clientVersion: "1\u0000" }],
  ])("rejects %s", (_label, body) => {
    expect(heartbeatRequestSchema.safeParse(body).success).toBe(false);
  });

  it("accepts the maximum length and astral characters", () => {
    expect(
      heartbeatRequestSchema.safeParse({ ...valid, clientVersion: "x".repeat(64) }).success,
    ).toBe(true);
    expect(
      heartbeatRequestSchema.safeParse({ ...valid, clientVersion: "v\u{1F600}" }).success,
    ).toBe(true);
  });
});
