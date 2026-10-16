import {
  createServer,
  request as httpRequest,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A loopback HTTP proxy between the extension and the API, so a test can take "the network" away
 * without touching the browser (Playwright's `setOffline` does not reach an extension's service
 * worker or Firefox's event page).
 *
 * - `online`: forwards everything.
 * - `offline`: resets every connection before the API sees the request (fetch rejects with a
 *   network error, exactly like a dropped connection).
 * - `drop-responses`: forwards the request, the API handles it, and then the connection is reset
 *   instead of relaying the response. The server stored the batch but the client never learns it:
 *   the at-least-once retry that follows is what the dedupe key has to absorb.
 * - `hold-requests`: an ingest request (`/v1/ingest/...`) is read in full and then PARKED, not
 *   forwarded: the batch is in flight and the API has not seen it. Other paths are forwarded.
 * - `hold-responses`: an ingest request is forwarded and the API stores it, then the response is
 *   PARKED: the batch is in flight, already stored, and the client does not know.
 *
 * Parked requests give a test a stable "a flush is in flight right now" moment to kill the
 * background in (`waitForHeld`), and `releaseHeld` ends it. A parked request whose client has gone
 * away (the background was killed and the browser cancelled the request) is abandoned: a
 * `hold-requests` one is never forwarded, so the API never sees it.
 */
export type ProxyMode =
  | "online"
  | "offline"
  | "drop-responses"
  | "hold-requests"
  | "hold-responses";

export interface FlakyProxy {
  /** `http://127.0.0.1:<port>`: this is the "server URL" the extension is paired with. */
  origin: string;
  setMode(mode: ProxyMode): void;
  readonly mode: ProxyMode;
  /** Requests seen per outcome, so a test can prove the extension really tried (and failed). */
  readonly counts: {
    forwarded: number;
    refused: number;
    responsesDropped: number;
    /** Requests parked so far, ever (both hold modes). */
    held: number;
    /** Parked requests that were never completed because their client had gone away. */
    abandoned: number;
  };
  /** Requests parked right now. */
  readonly heldNow: number;
  /** Parked requests whose client has already gone away (the browser cancelled the request). */
  readonly heldGone: number;
  /** Resolves once at least `count` requests are parked (rejects after `timeout` ms). */
  waitForHeld(count: number, timeout?: number): Promise<void>;
  /**
   * Completes every parked request: `hold-requests` ones are forwarded now and `hold-responses`
   * ones relayed, unless their client is already gone (then they are abandoned). Returns how many
   * were completed (not abandoned).
   */
  releaseHeld(): number;
  close(): Promise<void>;
}

const INGEST_PREFIX = "/v1/ingest";

export async function startFlakyProxy(target: string): Promise<FlakyProxy> {
  const upstream = new URL(target);
  let mode: ProxyMode = "online";
  const counts = { forwarded: 0, refused: 0, responsesDropped: 0, held: 0, abandoned: 0 };
  /** `finish` completes one parked request (false when its client was gone), `gone` peeks. */
  interface Parked {
    finish(): boolean;
    gone(): boolean;
  }
  const held = new Set<Parked>();
  const heldWaiters = new Set<() => void>();
  const park = (entry: Parked): void => {
    held.add(entry);
    counts.held += 1;
    for (const wake of heldWaiters) wake();
  };

  const server: Server = createServer((req, res) => {
    if (mode === "offline") {
      counts.refused += 1;
      req.socket.destroy();
      return;
    }
    const holdsThis = req.url?.startsWith(INGEST_PREFIX) === true;
    const holdMode = holdsThis && (mode === "hold-requests" || mode === "hold-responses");

    const body: Buffer[] = [];
    req.on("data", (chunk: Buffer) => body.push(chunk));
    req.on("end", () => {
      const forward = (
        relay: (incoming: Buffer, status: number, headers: OutgoingHttpHeaders) => void,
      ) => {
        const outgoing = httpRequest(
          {
            host: upstream.hostname,
            port: upstream.port,
            method: req.method,
            path: req.url,
            headers: req.headers,
            agent: false,
          },
          (incoming) => {
            // Drain the upstream response first, so the API completes the request in full.
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
            incoming.on("end", () => {
              const headers = { ...incoming.headers };
              // Relayed whole: drop hop-by-hop framing, let Node set the length.
              delete headers["transfer-encoding"];
              delete headers.connection;
              relay(Buffer.concat(chunks), incoming.statusCode ?? 502, headers);
            });
          },
        );
        outgoing.on("error", () => {
          req.socket.destroy();
        });
        outgoing.end(Buffer.concat(body));
      };

      // The browser cancelled the request (the background was killed): the socket is closed or ending.
      const clientGone = (): boolean => req.socket.destroyed || !req.socket.writable;

      const answer = (payload: Buffer, status: number, headers: OutgoingHttpHeaders): void => {
        counts.forwarded += 1;
        res.writeHead(status, headers).end(payload);
      };

      if (holdMode && mode === "hold-requests") {
        // Parked before the API sees anything.
        park({
          gone: clientGone,
          finish: () => {
            if (clientGone()) {
              counts.abandoned += 1;
              return false;
            }
            forward(answer);
            return true;
          },
        });
        return;
      }

      forward((payload, status, headers) => {
        if (mode === "drop-responses") {
          counts.responsesDropped += 1;
          req.socket.destroy();
          return;
        }
        if (holdMode) {
          // The API has stored the batch; the response waits.
          park({
            gone: clientGone,
            finish: () => {
              if (clientGone()) {
                counts.abandoned += 1;
                return false;
              }
              answer(payload, status, headers);
              return true;
            },
          });
          return;
        }
        answer(payload, status, headers);
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    setMode: (next) => {
      mode = next;
    },
    get mode() {
      return mode;
    },
    counts,
    get heldNow() {
      return held.size;
    },
    get heldGone() {
      return [...held].filter((entry) => entry.gone()).length;
    },
    waitForHeld: (count, timeout = 30_000) =>
      new Promise<void>((resolve, reject) => {
        if (held.size >= count) return resolve();
        const timer = setTimeout(() => {
          heldWaiters.delete(check);
          reject(
            new Error(`the proxy parked ${held.size} of ${count} requests within ${timeout} ms`),
          );
        }, timeout);
        function check() {
          if (held.size < count) return;
          clearTimeout(timer);
          heldWaiters.delete(check);
          resolve();
        }
        heldWaiters.add(check);
      }),
    releaseHeld: () => {
      let completed = 0;
      for (const entry of [...held]) {
        held.delete(entry);
        if (entry.finish()) completed += 1;
      }
      return completed;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        held.clear();
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
