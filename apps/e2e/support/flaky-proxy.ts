import { createServer, request as httpRequest, type Server } from "node:http";
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
 */
export type ProxyMode = "online" | "offline" | "drop-responses";

export interface FlakyProxy {
  /** `http://127.0.0.1:<port>`: this is the "server URL" the extension is paired with. */
  origin: string;
  setMode(mode: ProxyMode): void;
  readonly mode: ProxyMode;
  /** Requests seen per outcome, so a test can prove the extension really tried (and failed). */
  readonly counts: { forwarded: number; refused: number; responsesDropped: number };
  close(): Promise<void>;
}

export async function startFlakyProxy(target: string): Promise<FlakyProxy> {
  const upstream = new URL(target);
  let mode: ProxyMode = "online";
  const counts = { forwarded: 0, refused: 0, responsesDropped: 0 };

  const server: Server = createServer((req, res) => {
    if (mode === "offline") {
      counts.refused += 1;
      req.socket.destroy();
      return;
    }
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
          if (mode === "drop-responses") {
            counts.responsesDropped += 1;
            req.socket.destroy();
            return;
          }
          counts.forwarded += 1;
          const headers = { ...incoming.headers };
          // Relayed whole: drop hop-by-hop framing, let Node set the length.
          delete headers["transfer-encoding"];
          delete headers.connection;
          res.writeHead(incoming.statusCode ?? 502, headers).end(Buffer.concat(chunks));
        });
      },
    );
    outgoing.on("error", () => {
      req.socket.destroy();
    });
    req.pipe(outgoing);
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
