/** Shared fixtures for the M1-01 specs. Not part of the package's public API. */
export const UUID_V7 = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";
export const OCCURRED_AT = "2026-10-13T10:05:00.000Z";
export const TAB_REF = "k3j2h1g4f5d6a7b8";

export const META = { ruleSetVersion: 7, client: "pa-extension/0.1.0" } as const;

export function pageVisited(
  data: Record<string, unknown> = {},
  envelope: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: UUID_V7,
    type: "browser.page_visited",
    typeVersion: 1,
    occurredAt: OCCURRED_AT,
    data: {
      domain: "github.com",
      path: "/Mohaned178/IdentiK",
      transition: "link",
      tabRef: TAB_REF,
      ...data,
    },
    meta: META,
    ...envelope,
  };
}

/** A focus_segment whose durationMs matches startedAt/endedAt (5 minutes by default). */
export function focusSegment(
  data: Record<string, unknown> = {},
  envelope: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: UUID_V7,
    type: "browser.focus_segment",
    typeVersion: 1,
    occurredAt: "2026-10-13T10:05:00.000Z",
    data: {
      domain: "github.com",
      path: "/Mohaned178/IdentiK",
      startedAt: "2026-10-13T10:00:00.000Z",
      endedAt: "2026-10-13T10:05:00.000Z",
      durationMs: 300_000,
      ...data,
    },
    meta: META,
    ...envelope,
  };
}

export function withoutKey<T extends Record<string, unknown>>(obj: T, key: string): T {
  const copy: Record<string, unknown> = { ...obj };
  delete copy[key];
  return copy as T;
}
