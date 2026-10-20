import { readdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { FIREFOX_EXTENSION_PATH, launchFirefoxExtension } from "../support/firefox";
import { expect, test } from "../support/fixtures";
import { startFlakyProxy } from "../support/flaky-proxy";
import {
  CONNECTION_KEY,
  pageVisits,
  pairThroughPopupFirefox,
  type StoredConnection,
  syncRulesFirefox,
  triggerFlushFirefox,
  visitedPaths,
  visitFirefox,
} from "../support/pairing";
import { LOOPBACK_HOST_PERMISSION, patchBuildWithHostPermissions } from "../support/patched-build";
import { allowDomainsRule, type RuleDocument } from "../support/stack";

// M7-01: the v1 definition of done. The whole 8-step demo as ONE test on the real firefox-mv3 build
// in headless Firefox, against the real API, the real worker and a real Postgres.
//
//   1. sign up and log in
//   2. pair the extension with a pairing code
//   3. a rule allows a site: before it nothing is collected (deny by default), after it the visit is
//   4. the events show up through the API, with the query string and fragment stripped
//   5. create a read key and a saved-query endpoint
//   6. read the endpoint with its own key
//   7. change the rule: later visits behave differently, and the endpoint follows
//   8. export the data, then delete the account and everything is gone
//
// The account steps call the same HTTP routes the dashboard calls, with the user's session (the
// dashboard's own screens are covered by apps/web's tests). The browser steps drive the real popup
// and real navigations. Needs `pnpm --filter extension build:firefox`, the built API, Firefox +
// geckodriver and Docker (or E2E_DATABASE_URL); always runs in CI via `test:e2e`.
//
// Two hostnames reach the same fixture site: `127.0.0.1` and `localhost`. The rule allows one of
// them, then the other. Visits are read back after a flush, in order, so a denied visit that was
// made before an allowed one would have arrived with it if it had been queued.

const IP_DOMAIN = "127.0.0.1";
const NAME_DOMAIN = "localhost";
const ARRIVAL_TIMEOUT_MS = 60_000;
const SLUG = "demo-visits-by-domain";

interface ApiEvent {
  id: string;
  type: string;
  data: { domain?: string; path?: string };
  trace: { ruleSetVersion: number } | null;
}

test("the full 8-step demo on Firefox", async ({ stack, site }) => {
  test.setTimeout(480_000);
  const proxy = await startFlakyProxy(stack.apiOrigin);
  const build = await patchBuildWithHostPermissions(FIREFOX_EXTENSION_PATH, [
    LOOPBACK_HOST_PERMISSION,
  ]);
  const firefox = await launchFirefoxExtension({ extensionPath: build.path });
  try {
    const port = new URL(site.origin).port;
    const url = (domain: string, path: string) => `http://${domain}:${port}${path}`;
    const tab = await firefox.openTab(`${site.origin}/`);

    const flushUntilArrived = async (
      account: { integrationId: string },
      domain: string,
      path: string,
    ) => {
      await triggerFlushFirefox(firefox);
      await expect
        .poll(async () => visitedPaths(await stack.eventsOf(account.integrationId), domain), {
          timeout: ARRIVAL_TIMEOUT_MS,
          intervals: [500],
        })
        .toContain(path);
    };

    // ---- 1. sign up and log in -------------------------------------------------------------
    // No rule yet: the user has not allowed anything.
    const account = await stack.createPairableAccount("demo", []);
    const paths = async (domain: string) =>
      visitedPaths(await stack.eventsOf(account.integrationId), domain);
    await test.step("1. sign up and log in", async () => {
      const me = await account.request("GET", "/v1/me");
      expect(me.status).toBe(200);
      expect(((await me.json()) as { email: string }).email).toBe(account.email);
      // Without the session cookie the same route refuses.
      expect((await fetch(`${stack.apiOrigin}/v1/me`)).status).toBe(401);
    });

    // ---- 2. pair the extension -------------------------------------------------------------
    let ingestKey = "";
    await test.step("2. pair the extension with a pairing code", async () => {
      await pairThroughPopupFirefox(firefox, proxy.origin, account.pairingCode);
      const stored = (await firefox.storageGet(CONNECTION_KEY))[CONNECTION_KEY] as
        | StoredConnection
        | undefined;
      expect(stored?.integrationId).toBe(account.integrationId);
      expect(stored?.ingestKey).toMatch(/^pa_ing_.{10,}/);
      ingestKey = stored?.ingestKey ?? "";
      expect(await stack.pairingCodeUsed(account.integrationId)).toBe(true);
    });

    // ---- 3. a rule allows a site -----------------------------------------------------------
    let ruleId = "";
    await test.step("3. nothing is collected until a rule allows the site, then it is", async () => {
      // Paired with no rule: the extension holds an empty rule set and denies by default.
      await syncRulesFirefox(firefox, 0);
      await visitFirefox(firefox, tab, url(IP_DOMAIN, "/p/1"));
      await triggerFlushFirefox(firefox);

      const rule = await account.rules.create(allowDomainsRule([IP_DOMAIN]));
      ruleId = rule.id;
      expect(rule.version).toBe(1);
      await syncRulesFirefox(firefox, 1);

      // The visit with a query string and a fragment: only domain and path may be kept.
      await visitFirefox(firefox, tab, url(IP_DOMAIN, "/p/2"));
      await visitFirefox(firefox, tab, url(IP_DOMAIN, "/b?q=secret#frag"));
      await flushUntilArrived(account, IP_DOMAIN, "/b");
      // The visit made before the rule never arrived, and never will.
      expect(await paths(IP_DOMAIN)).toEqual(["/p/2", "/b"]);
    });

    // ---- 4. the events are in the API, stripped --------------------------------------------
    let eventIds: string[] = [];
    await test.step("4. the events appear through the API with no query or fragment", async () => {
      const listed = await account.request("GET", "/v1/events");
      expect(listed.status).toBe(200);
      const { events } = (await listed.json()) as { events: ApiEvent[] };
      const visits = events.filter((event) => event.type === "browser.page_visited");
      expect(visits.map((event) => event.data.path).sort()).toEqual(["/b", "/p/2"]);
      expect(visits.every((event) => event.trace?.ruleSetVersion === 1)).toBe(true);
      eventIds = events.map((event) => event.id);
      // Nothing of the query string or the fragment is anywhere in what was stored.
      const stored = JSON.stringify(
        (await stack.eventsOf(account.integrationId)).map((e) => e.data),
      );
      expect(stored).not.toContain("q=secret");
      expect(stored).not.toContain("#");
      expect(stored).not.toContain("?");
    });

    // ---- 5. a read key and a saved-query endpoint ------------------------------------------
    let readKey = "";
    let endpointKey = "";
    await test.step("5. create a read key and a saved-query endpoint", async () => {
      const keyRes = await account.request("POST", "/v1/keys", {
        name: "demo read",
        scopes: ["events:read"],
      });
      expect(keyRes.status).toBe(201);
      readKey = ((await keyRes.json()) as { key: string }).key;
      expect(readKey).toMatch(/^pa_read_/);

      const endpointRes = await account.request("POST", "/v1/endpoints", {
        slug: SLUG,
        definition: {
          when: { type: ["browser.page_visited"] },
          window: { kind: "last_n_days", days: 7 },
          aggregate: "count_by_domain",
        },
      });
      expect(endpointRes.status).toBe(201);
      endpointKey = ((await endpointRes.json()) as { key: string }).key;
      expect(endpointKey).toMatch(/^pa_read_/);
    });

    // ---- 6. read the endpoint with its own key ---------------------------------------------
    const readEndpoint = async (key: string) =>
      fetch(`${stack.apiOrigin}/v1/me/${SLUG}`, { headers: { authorization: `Bearer ${key}` } });
    await test.step("6. the endpoint answers with its own key, and only that", async () => {
      const res = await readEndpoint(endpointKey);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { kind: string; rows: unknown[] };
      expect(body.kind).toBe("count_by_domain");
      expect(body.rows).toEqual([{ domain: IP_DOMAIN, count: 2 }]);

      // The general read key reads events but is not an endpoint key, and an endpoint key does not
      // read events: each key does only what its scopes allow.
      const events = await fetch(`${stack.apiOrigin}/v1/events`, {
        headers: { authorization: `Bearer ${readKey}` },
      });
      expect(events.status).toBe(200);
      const crossed = await fetch(`${stack.apiOrigin}/v1/events`, {
        headers: { authorization: `Bearer ${endpointKey}` },
      });
      expect(crossed.status).toBe(403);
      // An ingest key can only ingest.
      const withIngestKey = await fetch(`${stack.apiOrigin}/v1/events`, {
        headers: { authorization: `Bearer ${ingestKey}` },
      });
      expect(withIngestKey.status).toBe(401);
    });

    // ---- 7. change the rule ----------------------------------------------------------------
    await test.step("7. changing the rule changes what later visits do", async () => {
      const flipped: RuleDocument = {
        ...allowDomainsRule([NAME_DOMAIN]),
        name: "e2e: allow the other hostname",
      };
      expect((await account.rules.replace(ruleId, flipped)).version).toBe(2);
      await syncRulesFirefox(firefox, 2);

      await visitFirefox(firefox, tab, url(IP_DOMAIN, "/p/3"));
      await visitFirefox(firefox, tab, url(NAME_DOMAIN, "/p/4"));
      await flushUntilArrived(account, NAME_DOMAIN, "/p/4");
      expect(await paths(IP_DOMAIN)).toEqual(["/p/2", "/b"]);
      expect(await paths(NAME_DOMAIN)).toEqual(["/p/4"]);

      // The endpoint reads the same data, so it follows.
      const body = (await (await readEndpoint(endpointKey)).json()) as { rows: unknown[] };
      expect(body.rows).toEqual([
        { domain: IP_DOMAIN, count: 2 },
        { domain: NAME_DOMAIN, count: 1 },
      ]);
      const events = await stack.eventsOf(account.integrationId);
      expect(pageVisits(events).map((event) => event.trace?.ruleSetVersion)).toEqual([1, 1, 2]);
      eventIds = events.map((event) => event.id);
    });

    // ---- 8. export, then delete the account ------------------------------------------------
    await test.step("8. export the data, then delete the account and it is all gone", async () => {
      await stack.startWorker();
      const started = await account.request("POST", "/v1/exports", {});
      expect(started.status).toBe(202);
      const exportId = ((await started.json()) as { export: { id: string } }).export.id;
      await expect
        .poll(
          async () =>
            (
              (await (await account.request("GET", `/v1/exports/${exportId}`)).json()) as {
                export: { status: string };
              }
            ).export.status,
          { timeout: 90_000, intervals: [500] },
        )
        .toBe("completed");

      const download = await account.request("GET", `/v1/exports/${exportId}/download`);
      expect(download.status).toBe(200);
      const lines = gunzipSync(Buffer.from(await download.arrayBuffer()))
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { id: string });
      expect(lines.map((line) => line.id).sort()).toEqual([...eventIds].sort());
      const manifest = (await (
        await account.request("GET", `/v1/exports/${exportId}/manifest`)
      ).json()) as { eventCount: number };
      expect(manifest.eventCount).toBe(eventIds.length);
      expect(await readdir(stack.exportDir)).toContain(exportId);

      const wrong = await account.request("DELETE", "/v1/account", {
        password: "not-the-password",
        confirm: "delete my account",
      });
      expect(wrong.status).toBe(403);
      expect((await account.request("GET", "/v1/me")).status).toBe(200);

      const deleted = await account.request("DELETE", "/v1/account", {
        password: account.password,
        confirm: "delete my account",
      });
      expect(deleted.status).toBe(204);

      // The session is gone, every key stopped working, and no row or file of the user is left.
      expect((await account.request("GET", "/v1/me")).status).toBe(401);
      expect((await readEndpoint(endpointKey)).status).toBe(401);
      const ingest = await fetch(`${stack.apiOrigin}/v1/ingest/config`, {
        headers: { authorization: `Bearer ${ingestKey}` },
      });
      expect(ingest.status).toBe(401);
      for (const [table, column] of [
        ["events", "user_id"],
        ["integrations", "user_id"],
        ["rules", "user_id"],
        ["endpoints", "user_id"],
        ["api_keys", "user_id"],
        ["user", "id"],
      ] as const) {
        const { rows } = await stack.pool.query<{ n: string }>(
          `select count(*)::text as n from "${table}" where ${column} = $1`,
          [account.userId],
        );
        expect(rows[0]?.n, `rows left in ${table}`).toBe("0");
      }
      expect(await readdir(stack.exportDir)).not.toContain(exportId);
    });
  } finally {
    await firefox.close().catch(() => {});
    await build.cleanup();
    await proxy.close();
  }
});
