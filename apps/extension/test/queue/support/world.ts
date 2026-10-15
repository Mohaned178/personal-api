// Test harness for M2-05: a fake IndexedDB "disk" that outlives every simulated worker kill, a
// server that behaves like POST /v1/ingest/events (dedupe on id, per-item results, problem+json
// errors), and a recording alarm fake. Nothing here uses timers or fake timers: time is `clock`,
// moved only by the tests, and fake-indexeddb runs on real `setImmediate`.
//
// Kill model. A killed background loses every in-memory object but keeps the IndexedDB data. The
// tests discard the old store and flusher (`kill` also closes the old connection, so a "zombie"
// continuation of the dead instance cannot touch the disk) and open new ones over the same
// `IDBFactory`. Requests the dead instance had in flight either never reached the server (`hang`)
// or were processed by it with the response lost (`processThenHang`); both never settle.

import "fake-indexeddb/auto";
import {
  INGEST_MAX_BATCH_BYTES,
  type IngestErrorCode,
  type IngestItemResult,
  ingestBatchRequestSchema,
  parseEvent,
} from "@personal-api/contracts";
import { IDBDatabase, IDBFactory } from "fake-indexeddb";
import { expect, vi } from "vitest";
import type { CapturedEvent } from "../../../lib/capture";
import type { Connection } from "../../../lib/connect";
import {
  createFlusher,
  createIdbCaptureStore,
  FLUSH_RETRY_ALARM_NAME,
  type FlushAlarms,
  type Flusher,
  type QueueLimits,
  type QueueOwner,
  type QueueStore,
} from "../../../lib/queue";

export const T0 = Date.UTC(2026, 9, 15, 10, 0, 0);
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const ORIGIN = "https://api.example.test";
export const KEY = "pa_ing_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const KEY_2 = "pa_ing_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
export const INTEGRATION_ID = "0193a000-1111-7000-8000-000000000001";
export const INTEGRATION_ID_2 = "0193a000-2222-7000-8000-000000000002";
export const ORIGIN_2 = "https://other.example.test";

export const SECRET_DOMAIN = "secret-domain.example";
export const SECRET_PATH_PREFIX = "/secret/path";

/** The queue owner of a connection (what the store stamps rows with). */
export function ownerOf(connection: Connection): QueueOwner {
  return { serverOrigin: connection.serverOrigin, integrationId: connection.integrationId };
}

export function connectionFor(key: string = KEY, owner: Partial<QueueOwner> = {}): Connection {
  return {
    serverOrigin: owner.serverOrigin ?? ORIGIN,
    ingestKey: key,
    integrationId: owner.integrationId ?? INTEGRATION_ID,
    integrationName: "Test browser",
  };
}

/**
 * A valid, deliberately NON-monotonic UUID: sorting by id never gives insertion order, so a store
 * that orders by id (or by `occurredAt`) is caught.
 */
export function uuid(i: number): string {
  // Odd multiplier mod 2^32 is a bijection (unique per i); the high bits of the product are
  // scrambled by the golden-ratio constant, and the sequence is reversed so small i are not ascending.
  const mixed = Math.imul(i + 1, 0x9e3779b1) >>> 0;
  const scrambled = (0xffffffff - mixed) * 0x10000 + (i & 0xffff);
  return `0192f1c2-7c1e-7a3b-9f00-${scrambled.toString(16).padStart(12, "0")}`;
}

/** A valid `browser.page_visited` event. `occurredAt` goes DOWN as `i` goes up (not sorted). */
export function pageEvent(
  i: number,
  options: { domain?: string; path?: string } = {},
): CapturedEvent {
  return {
    id: uuid(i),
    type: "browser.page_visited",
    typeVersion: 1,
    occurredAt: new Date(T0 - i * 1000).toISOString(),
    data: {
      domain: options.domain ?? SECRET_DOMAIN,
      path: options.path ?? `${SECRET_PATH_PREFIX}/${i}`,
      tabRef: "tabref-aaaa1111",
    },
  } as CapturedEvent;
}

export function pageEvents(n: number, from = 0): CapturedEvent[] {
  return Array.from({ length: n }, (_, k) => pageEvent(from + k));
}

/** A valid event whose body is ~4 KB of UTF-8 but only ~2 KB of UTF-16 (astral characters). */
export function bigEvent(i: number): CapturedEvent {
  return pageEvent(i, { path: `/${"\u{1F600}".repeat(1023)}` });
}

export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;
export const bodyBytes = (events: unknown[]): number => utf8Bytes(JSON.stringify({ events }));

/** `browser.storage.local.get(keys)` over a plain object: one entry per requested key (undefined when absent). */
export function pick(
  stored: Record<string, unknown>,
  keys: string | string[],
): Record<string, unknown> {
  return Object.fromEntries([keys].flat().map((key) => [key, stored[key]]));
}

export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Lets pending IndexedDB / promise work run, with real (not fake) macrotasks. */
export async function waitFor(condition: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (condition()) return;
    await tick();
  }
  throw new Error(`timed out waiting for: ${label}`);
}

// --------------------------------------------------------------------------------------------
// alarms

export class FakeAlarms implements FlushAlarms {
  creates: { name: string; when: number }[] = [];
  clears: string[] = [];
  /** The alarm that is currently set, by name (the browser keeps one alarm per name). */
  pending = new Map<string, number>();

  create(name: string, info: { when: number }): void {
    this.creates.push({ name, when: info.when });
    this.pending.set(name, info.when);
  }

  clear(name: string): boolean {
    this.clears.push(name);
    return this.pending.delete(name);
  }

  /** The flush must only ever touch its own one-shot alarm, never the 30 s heartbeat alarm. */
  expectOnlyRetryAlarm(): void {
    for (const call of this.creates) expect(call.name).toBe(FLUSH_RETRY_ALARM_NAME);
    for (const name of this.clears) expect(name).toBe(FLUSH_RETRY_ALARM_NAME);
  }

  get lastWhen(): number | undefined {
    return this.creates.at(-1)?.when;
  }
}

// --------------------------------------------------------------------------------------------
// the server

export type Behavior =
  /** Process the batch and answer 200 with the per-item results. */
  | { kind: "ok" }
  /** The request fails before reaching the server (fetch rejects). */
  | { kind: "network"; message?: string }
  /** The server answers this status WITHOUT processing the batch. */
  | { kind: "status"; status: number; body?: unknown; headers?: Record<string, string> }
  /** The request never reaches the server and never settles (the worker is killed). */
  | { kind: "hang" }
  /** The server stores the batch, then the response is lost and the call never settles. */
  | { kind: "processThenHang" }
  /** The server stores the batch, then the connection fails (fetch rejects). */
  | { kind: "processThenNetwork" }
  /** The server stores the batch, then answers this status. */
  | { kind: "processThenStatus"; status: number }
  /** The server stores the batch, then answers 200 with a body produced from the true results. */
  | { kind: "mangle"; body: (results: IngestItemResult[]) => unknown };

export interface ServerCall {
  index: number;
  url: string;
  init: RequestInit;
  headers: Headers;
  body: string;
  bytes: number;
  events: unknown[];
  ids: string[];
  behavior: Behavior["kind"];
  /** The HTTP status the client saw, or null when it never saw one. */
  status: number | null;
  /** What the server decided per item (even when the response was then lost), or null when it did not process the batch. */
  results: IngestItemResult[] | null;
}

const PROBLEM = "application/problem+json";

export class FakeServer {
  /** Events the server stored, by id (what "effectively once" means). */
  stored = new Map<string, unknown>();
  /** How many times the server answered `accepted` for an id (must end at exactly 1). */
  accepted = new Map<string, number>();
  ruleDropped = new Set<string>();
  calls: ServerCall[] = [];
  /** Responses the client actually received. */
  delivered = 0;
  maxConcurrent = 0;
  expectedKey: string | null = KEY;
  maxEventsPerRequest = 100;
  maxBytesPerRequest = INGEST_MAX_BATCH_BYTES;
  /** Events whose id this returns a code for are answered `rejected`. */
  rejectRule: (event: unknown) => IngestErrorCode | null = (event) =>
    String((event as { data?: { path?: unknown } } | null)?.data?.path).startsWith("/poison")
      ? "ingest.occurred_at_too_old"
      : null;
  /** Events this returns true for are answered `dropped` (a collect rule) and never stored. */
  dropRule: (event: unknown) => boolean = (event) =>
    String((event as { data?: { path?: unknown } } | null)?.data?.path).startsWith("/ruledrop");
  private plan: Behavior[] = [];
  /** Applied to every call once the plan is empty. */
  fallback: Behavior = { kind: "ok" };
  private holds: Promise<void>[] = [];
  private inFlight = 0;

  /** The next calls behave like this, in order. */
  next(...behaviors: Behavior[]): void {
    this.plan.push(...behaviors);
  }

  /** Forgets behaviors that were planned but not consumed. */
  clearPlan(): void {
    this.plan = [];
    this.holds = [];
  }

  revoke(): void {
    this.expectedKey = null;
  }

  /** The next response is delayed until the returned function is called (the batch is processed first). */
  holdNextResponse(): () => void {
    let release!: () => void;
    this.holds.push(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return release;
  }

  acceptedIds(): string[] {
    return [...this.accepted.keys()];
  }

  /** Every id ever sent, in call order. */
  sentIds(): string[] {
    return this.calls.flatMap((call) => call.ids);
  }

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const behavior = this.plan.shift() ?? this.fallback;
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? init.body : "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    const events =
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { events?: unknown }).events)
        ? (parsed as { events: unknown[] }).events
        : [];
    const call: ServerCall = {
      index: this.calls.length,
      url,
      init,
      headers,
      body,
      bytes: utf8Bytes(body),
      events,
      ids: events.map((event) => String((event as { id?: unknown })?.id)),
      behavior: behavior.kind,
      status: null,
      results: null,
    };
    this.calls.push(call);
    this.inFlight++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    try {
      return await this.respond(call, behavior, parsed);
    } finally {
      this.inFlight--;
    }
  };

  private async respond(call: ServerCall, behavior: Behavior, parsed: unknown): Promise<Response> {
    switch (behavior.kind) {
      case "network":
        throw new TypeError(behavior.message ?? "fetch failed");
      case "hang":
        return new Promise<Response>(() => {});
      case "status":
        return this.deliver(
          call,
          this.json(behavior.status, behavior.body ?? problem(behavior.status), behavior.headers),
        );
      default:
        break;
    }

    const auth = this.authenticate(call.headers);
    if (auth) return this.deliver(call, auth);

    const processed = this.process(call, parsed);
    if (processed instanceof Response) return this.deliver(call, processed);
    const results = processed;
    call.results = results;

    const hold = this.holds.shift();
    if (hold) await hold;

    switch (behavior.kind) {
      case "processThenHang":
        return new Promise<Response>(() => {});
      case "processThenNetwork":
        throw new TypeError("fetch failed");
      case "processThenStatus":
        return this.deliver(call, this.json(behavior.status, problem(behavior.status)));
      case "mangle":
        return this.deliver(call, this.json(200, behavior.body(results)));
      default:
        return this.deliver(call, this.json(200, { results }));
    }
  }

  private deliver(call: ServerCall, response: Response): Response {
    call.status = response.status;
    this.delivered++;
    return response;
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: {
        "content-type": status >= 400 ? PROBLEM : "application/json",
        ...headers,
      },
    });
  }

  private authenticate(headers: Headers): Response | null {
    const auth = headers.get("authorization");
    if (this.expectedKey === null || auth !== `Bearer ${this.expectedKey}`) {
      return this.json(401, { ...problem(401), code: "auth.invalid_key" });
    }
    return null;
  }

  /** Mirrors the real route: size limits, then per-item validation, dedupe and rules. */
  private process(call: ServerCall, parsed: unknown): IngestItemResult[] | Response {
    if (call.bytes > this.maxBytesPerRequest) {
      return this.json(413, { ...problem(413), code: "http.payload_too_large" });
    }
    const request = ingestBatchRequestSchema.safeParse(parsed);
    if (!request.success || request.data.events.length > this.maxEventsPerRequest) {
      return this.json(400, { ...problem(400), code: "ingest.batch_invalid" });
    }
    return request.data.events.map((raw): IngestItemResult => {
      const event = parseEvent(raw);
      if (!event.ok) {
        const id = (raw as { id?: unknown })?.id;
        return typeof id === "string"
          ? { id, status: "rejected", code: event.code }
          : { status: "rejected", code: event.code };
      }
      const id = event.event.id;
      const code = this.rejectRule(raw);
      if (code) return { id, status: "rejected", code };
      if (this.ruleDropped.has(id) || this.dropRule(raw)) {
        this.ruleDropped.add(id);
        return { id, status: "dropped" };
      }
      if (this.stored.has(id)) return { id, status: "duplicate" };
      this.stored.set(id, raw);
      this.accepted.set(id, (this.accepted.get(id) ?? 0) + 1);
      return { id, status: "accepted" };
    });
  }
}

function problem(status: number): { type: string; title: string; status: number; code: string } {
  return { type: "about:blank", title: `HTTP ${status}`, status, code: `http.status_${status}` };
}

// --------------------------------------------------------------------------------------------
// the world

export interface Instance {
  store: QueueStore;
  flusher: Flusher;
}

interface TransactionRecord {
  mode: IDBTransactionMode;
  durability: unknown;
  /** `server.delivered` when the transaction was opened. */
  delivered: number;
}

export class World {
  readonly factory = new IDBFactory();
  clock = T0;
  random = 0;
  readonly server = new FakeServer();
  readonly alarms = new FakeAlarms();
  connection: Connection | null = connectionFor(KEY);
  readonly now = (): number => this.clock;
  /** Every transaction opened on any database, in order. */
  transactions: TransactionRecord[] = [];
  private armed: "none" | "next" | "afterResponse" = "none";
  private armedAt = 0;
  abortedTransactions = 0;
  private original: typeof IDBDatabase.prototype.transaction | undefined;
  private instances: Instance[] = [];

  /** Spies on `IDBDatabase.prototype.transaction`. Call `uninstall()` in `afterEach`. */
  install(): void {
    const world = this;
    const original = IDBDatabase.prototype.transaction;
    this.original = original;
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      ...args: Parameters<typeof original>
    ) {
      const tx = original.apply(this, args);
      const mode = (args[1] ?? "readonly") as IDBTransactionMode;
      const options = args[2] as { durability?: unknown } | undefined;
      world.transactions.push({
        mode,
        durability: options?.durability,
        delivered: world.server.delivered,
      });
      if (
        mode === "readwrite" &&
        (world.armed === "next" ||
          (world.armed === "afterResponse" && world.server.delivered > world.armedAt))
      ) {
        world.armed = "none";
        world.abortedTransactions++;
        // Before any request of the transaction ran: a worker killed mid-transaction.
        queueMicrotask(() => {
          try {
            tx.abort();
          } catch {
            // already finished
          }
        });
      }
      return tx;
    };
  }

  uninstall(): void {
    if (this.original) IDBDatabase.prototype.transaction = this.original;
    for (const instance of this.instances) instance.store.close();
    this.instances = [];
  }

  /** The next readwrite transaction is aborted before it commits (the worker died inside it). */
  abortNextReadwrite(): void {
    this.armed = "next";
  }

  /** The first readwrite transaction opened after the next server response is aborted. */
  abortResultTransaction(): void {
    this.armed = "afterResponse";
    this.armedAt = this.server.delivered;
  }

  /** Cancels an abort that was armed but not used. */
  disarm(): void {
    this.armed = "none";
  }

  readwriteSince(delivered: number): TransactionRecord[] {
    return this.transactions.filter((tx) => tx.mode === "readwrite" && tx.delivered >= delivered);
  }

  /** Starts a background: new store and flusher over the same disk. */
  open(limits?: Partial<QueueLimits>): Instance {
    const store = createIdbCaptureStore({
      indexedDB: this.factory,
      now: this.now,
      ...(limits ? { limits } : {}),
    });
    const flusher = createFlusher({
      store,
      getConnection: async () => (this.connection ? { ...this.connection } : null),
      fetch: this.server.fetch,
      alarms: this.alarms,
      now: this.now,
      random: () => this.random,
    });
    const instance = { store, flusher };
    this.instances.push(instance);
    return instance;
  }

  /** A worker kill: all in-memory state is gone, the disk stays. The dead instance is cut off. */
  kill(instance: Instance): void {
    instance.store.close();
  }

  /** Kill and start a new background, which runs `start()` as the entrypoint does. */
  async restart(instance: Instance, limits?: Partial<QueueLimits>): Promise<Instance> {
    this.kill(instance);
    const next = this.open(limits);
    await next.flusher.start();
    return next;
  }

  /** With a healthy server: flush (past any backoff) until the queue is empty. */
  async drain(instance: Instance): Promise<void> {
    this.server.fallback = { kind: "ok" };
    for (let i = 0; i < 40; i++) {
      this.clock += 2 * 15 * MINUTE;
      await instance.flusher.flush();
      if ((await instance.store.stats()).depth === 0) return;
    }
    throw new Error("the queue did not drain");
  }

  async enqueue(instance: Instance, events: CapturedEvent[]): Promise<void> {
    // Events are captured while connected: the store stamps them for the current connection.
    if (this.connection) await instance.store.setOwner(ownerOf(this.connection));
    await instance.store.transact((prev) => ({ state: prev ?? { created: true }, events }));
  }

  async queued(instance: Instance): Promise<CapturedEvent[]> {
    const rows = await instance.store.peekBatch({
      maxEvents: 1_000_000,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });
    return rows.map((row) => row.event);
  }
}

/** A store whose given methods are replaced, everything else delegates (for failure injection). */
export function withOverrides(store: QueueStore, overrides: Partial<QueueStore>): QueueStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property in overrides) return Reflect.get(overrides, property, receiver);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Spies on every console method; none may be called (invariant 6). */
export function spyOnConsole(): { expectSilent(): void; restore(): void } {
  const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
  return {
    expectSilent() {
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    },
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

export function expectBatchesValid(server: FakeServer): void {
  for (const call of server.calls) {
    if (call.behavior === "network" || call.behavior === "hang") continue;
    expect(ingestBatchRequestSchema.safeParse(JSON.parse(call.body)).success).toBe(true);
    for (const event of call.events) expect(parseEvent(event).ok).toBe(true);
  }
}
