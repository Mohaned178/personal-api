import { describe, expect, it } from "vitest";
import { AppException } from "../../platform/errors/problem";
import { decodeCursor, encodeCursor } from "./events.cursor";

const ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";

describe("events cursor", () => {
  it("round-trips", () => {
    const position = { occurredAt: new Date("2026-10-14T12:00:00.123Z"), id: ID };
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  it.each([
    ["not base64 json", "%%%"],
    ["plain text", "hello"],
    ["an object", b64({ a: 1 })],
    ["wrong length", b64(["2026-10-14T12:00:00.000Z"])],
    ["bad date", b64(["yesterday", ID])],
    ["non-canonical date", b64(["2026-10-14", ID])],
    ["expanded positive year", b64(["+010000-01-01T00:00:00.000Z", ID])],
    ["expanded negative year", b64(["-000001-01-01T00:00:00.000Z", ID])],
    ["bad id", b64(["2026-10-14T12:00:00.000Z", "1 or 1=1"])],
    ["non-string date", b64([5, ID])],
  ])("rejects %s with events.cursor_invalid", (_label, cursor) => {
    let thrown: unknown;
    try {
      decodeCursor(cursor);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppException);
    expect((thrown as AppException).code).toBe("events.cursor_invalid");
    expect((thrown as AppException).getStatus()).toBe(400);
  });
});
