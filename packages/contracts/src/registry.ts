import type { z } from "zod";
import {
  focusSegmentV1Schema,
  pageVisitedV1Schema,
  sessionEndedV1Schema,
  sessionStartedV1Schema,
  tabClosedV1Schema,
  tabOpenedV1Schema,
} from "./browser-events.js";
import type { EventEnvelope } from "./envelope.js";

/**
 * Every accepted event type, keyed `type@version`, mapped to the strict schema for its `data`.
 * A type or version that is not listed here is rejected. Adding a type starts here.
 */
export const eventTypeRegistry = Object.freeze({
  "browser.page_visited@1": pageVisitedV1Schema,
  "browser.focus_segment@1": focusSegmentV1Schema,
  "browser.tab_opened@1": tabOpenedV1Schema,
  "browser.tab_closed@1": tabClosedV1Schema,
  "browser.session_started@1": sessionStartedV1Schema,
  "browser.session_ended@1": sessionEndedV1Schema,
});

type Registry = typeof eventTypeRegistry;

/** A registry key such as `"browser.page_visited@1"`. */
export type EventTypeKey = keyof Registry;

/** A registered event type name such as `"browser.page_visited"`. */
export type EventType = EventTypeKey extends `${infer T}@${number}` ? T : never;

/** The registry key for a type and version. */
export function eventTypeKey(type: string, typeVersion: number): string {
  return `${type}@${typeVersion}`;
}

/** Every registered type name, whatever its versions. */
export const EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.keys(eventTypeRegistry).map((key) => key.slice(0, key.lastIndexOf("@"))),
);

/** Looks up the data schema for a key. Own properties only, so `__proto__@1` finds nothing. */
export function getEventDataSchema(key: string): z.ZodType | undefined {
  return Object.hasOwn(eventTypeRegistry, key) ? eventTypeRegistry[key as EventTypeKey] : undefined;
}

/** A validated event: the envelope with `type`, `typeVersion` and `data` narrowed together. */
export type KnownEvent = {
  [K in EventTypeKey]: K extends `${infer T}@${infer V extends number}`
    ? Omit<EventEnvelope, "type" | "typeVersion" | "data"> & {
        type: T;
        typeVersion: V;
        data: z.output<Registry[K]>;
      }
    : never;
}[EventTypeKey];
