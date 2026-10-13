import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FixtureSite {
  /** Origin such as http://127.0.0.1:54321 (ephemeral port, loopback only). */
  origin: string;
  close(): Promise<void>;
}

const page = (title: string, links: readonly string[]): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body><h1>${title}</h1><nav>${links.map((l) => `<a href="${l}">${l}</a>`).join(" ")}</nav></body></html>`;

// Tiny static site with a few linked pages. No external network, no state.
const PAGES: Record<string, string> = {
  "/": page("Fixture home", ["/a", "/b?q=secret#frag"]),
  "/a": page("Fixture page A", ["/", "/b"]),
  "/b": page("Fixture page B", ["/", "/a"]),
};

export async function startFixtureSite(): Promise<FixtureSite> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const body = PAGES[path];
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
