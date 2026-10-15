import { describe, expect, it } from "vitest";
import { sanitizeUrl } from "../../lib/sanitize-url";
import { flush, iso, newSim, setupSimTests, T0 } from "./support/sim";

// M2-04: browser.page_visited. One event per completed navigation (`status: "complete"`, the
// choice ADR 0002 measured), sanitized through M2-03, committed straight from the listener.

setupSimTests();

const UNSUPPORTED = [
  "about:blank",
  "about:preferences#privacy",
  "chrome://settings/passwords",
  "edge://settings",
  "moz-extension://abc123/popup.html",
  "chrome-extension://abcdefghijklmnop/popup.html",
  "file:///C:/Users/me/secret.txt",
  "javascript:alert(1)",
  "data:text/html,<h1>x</h1>",
  "blob:https://example.com/3a1b",
  "ftp://example.com/file",
  "view-source:https://example.com/",
  "http://[::1]/local",
  `https://example.com/${"a".repeat(3000)}`,
  "not a url",
  "",
];

describe("page_visited", () => {
  it("emits one browser.page_visited per completed navigation with sanitized domain and path", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, "https://Example.COM/a/b?q=secret&token=1#frag");
    expect(sim.ofType("browser.page_visited")).toHaveLength(1);
    expect(sim.ofType("browser.page_visited")[0]).toMatchObject({
      type: "browser.page_visited",
      typeVersion: 1,
      occurredAt: iso(T0),
      data: { domain: "example.com", path: "/a/b" },
    });
    expect(sim.store.dump()).not.toMatch(/secret|token|frag|q=/);
  });

  it("emits the sanitizer's output for query strings, fragments, credentials, ports and encodings", async () => {
    const urls = [
      "https://user:pw@example.com:8443/p?x=1#f",
      "https://example.com",
      "https://example.com?only=query",
      "https://example.com/a%3Fb%23c",
      "https://EXAMPLE.com./x",
      "https://b\u00fccher.example/\u00fc?x",
    ];
    const sim = newSim();
    await sim.start();
    for (const url of urls) await sim.navigate(sim.tabId, url);
    expect(sim.visits().map(({ domain, path }) => ({ domain, path }))).toEqual(
      urls.map((url) => sanitizeUrl(url)),
    );
    expect(sim.visits().map((v) => v.path)).toEqual([
      "/p",
      "/",
      "/",
      "/a%3Fb%23c",
      "/x",
      "/%C3%BC",
    ]);
  });

  it.each(UNSUPPORTED)("emits nothing for %s and still captures the next page", async (url) => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, url);
    expect(sim.ofType("browser.page_visited")).toEqual([]);
    expect(sim.ofType("browser.focus_segment")).toEqual([]);
    await sim.navigate(sim.tabId, "https://ok.test/next");
    expect(sim.visits().map((v) => v.domain)).toEqual(["ok.test"]);
  });

  it("captures only status complete: loading, url-only and title updates emit nothing", async () => {
    const sim = newSim();
    await sim.start();
    const tab = sim.browser.mustTab(sim.tabId);
    tab.url = "https://a.test/page";
    tab.status = "loading";
    await sim.update(sim.tabId, { status: "loading", url: "https://a.test/page" });
    await sim.update(sim.tabId, { url: "https://a.test/page" });
    await sim.update(sim.tabId, { title: "Secret title", favIconUrl: "https://a.test/f.ico" });
    expect(sim.ofType("browser.page_visited")).toEqual([]);
    tab.status = "complete";
    await sim.update(sim.tabId, { status: "complete" });
    expect(sim.visits().map((v) => v.path)).toEqual(["/page"]);
    expect(sim.store.dump()).not.toContain("Secret title");
  });

  it("counts a reload of the same page again", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, "https://a.test/page");
    await sim.reload(sim.tabId);
    expect(sim.visits().map((v) => v.path)).toEqual(["/page", "/page"]);
  });

  it("gives every event a distinct id from the injected generator", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, "https://a.test/1");
    await sim.navigate(sim.tabId, "https://a.test/2");
    const ids = sim.queue.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("0193a000-0000-7000-8000-"))).toBe(true);
  });

  it("stamps events with the injected clock, not Date.now", async () => {
    const sim = newSim({ now: () => T0 + 123_456 });
    await sim.start();
    await sim.navigate(sim.tabId, "https://a.test/1");
    expect(sim.ofType("browser.page_visited")[0]?.occurredAt).toBe(iso(T0 + 123_456));
    expect(sim.ofType("browser.session_started")[0]?.occurredAt).toBe(iso(T0 + 123_456));
  });

  it("commits a completed navigation even when every browser query hangs and start() never ran", async () => {
    // ADR 0002 option B: the capture path awaits no chrome API except the session id.
    const sim = newSim();
    sim.browser.hang = true;
    sim.browser.mustTab(sim.tabId).url = "https://a.test/fast";
    void sim.update(sim.tabId, { status: "complete" });
    await flush();
    expect(sim.visits().map((v) => v.path)).toEqual(["/fast"]);
  });

  it("persists only domain and path, never the URL, query, fragment or title", async () => {
    const sim = newSim();
    await sim.start();
    await sim.navigate(sim.tabId, "https://user:pw@a.test:8443/p/q?token=s3cr3t#frag");
    await sim.update(sim.tabId, { title: "My Bank Statement" });
    const dump = sim.store.dump();
    for (const forbidden of ["s3cr3t", "token", "frag", "user:pw", "8443", "https://", "Bank"]) {
      expect(dump).not.toContain(forbidden);
    }
    expect(dump).toContain("a.test");
  });
});
