import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTION_STORAGE_KEY,
  type ConnectDeps,
  ConnectError,
  connect,
  disconnect,
  getConnection,
  normalizeServerUrl,
} from "../lib/connect";

// M2-02: connect/disconnect logic with injected browser + network deps (nothing global).

const CODE = "ABCD-EFGH-JKLM-NPQR-STUV";
const KEY = "pa_ing_SECRETKEYSECRETKEYSECRETKEY";
const INTEGRATION_ID = "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b";

const pairBody = {
  integration: {
    id: INTEGRATION_ID,
    kind: "browser-extension",
    name: "Work laptop",
    defaultPolicy: "deny",
    status: "active",
    lastSeenAt: null,
    createdAt: "2026-10-15T10:00:00.000Z",
  },
  ingestKey: { id: "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6c", key: KEY, prefix: "pa_ing_SECR" },
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function makeDeps() {
  const store: Record<string, unknown> = {};
  const calls: string[] = [];
  const deps = {
    permissions: {
      request: vi.fn(async (_p: { origins: string[] }) => {
        calls.push("permissions.request");
        return true;
      }),
      remove: vi.fn(async (_p: { origins: string[] }) => {
        calls.push("permissions.remove");
        return true;
      }),
    },
    storage: {
      get: vi.fn(async (key: string) => {
        calls.push("storage.get");
        return key in store ? { [key]: store[key] } : {};
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        calls.push("storage.set");
        Object.assign(store, items);
      }),
      remove: vi.fn(async (key: string) => {
        calls.push("storage.remove");
        delete store[key];
      }),
    },
    fetch: vi.fn(async (_url: string, _init: RequestInit): Promise<Response> => {
      calls.push("fetch");
      return json(pairBody);
    }),
  } satisfies ConnectDeps;
  return { deps, store, calls };
}

const input = { serverUrl: "https://api.example.com", pairingCode: CODE };

async function errorOf(p: Promise<unknown>): Promise<ConnectError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectError);
    return e as ConnectError;
  }
  throw new Error("expected a ConnectError, but the call resolved");
}

function codeOfSync(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectError);
    expect((e as ConnectError).message.length).toBeGreaterThan(0);
    return (e as ConnectError).code;
  }
  throw new Error("should have thrown a ConnectError");
}

afterEach(() => vi.restoreAllMocks());

describe("normalizeServerUrl", () => {
  it("returns the origin and the permission pattern for an https URL", () => {
    expect(normalizeServerUrl("https://api.example.com")).toEqual({
      origin: "https://api.example.com",
      originPattern: "https://api.example.com/*",
    });
  });

  it("strips path, query, fragment and credentials", () => {
    expect(normalizeServerUrl("https://user:pw@api.example.com/some/path?x=1#frag").origin).toBe(
      "https://api.example.com",
    );
  });

  it("handles a trailing slash and surrounding whitespace", () => {
    expect(normalizeServerUrl("  https://api.example.com/  ").origin).toBe(
      "https://api.example.com",
    );
  });

  it("drops a default port and keeps a non-default one in the origin", () => {
    expect(normalizeServerUrl("https://api.example.com:443").origin).toBe(
      "https://api.example.com",
    );
    expect(normalizeServerUrl("https://api.example.com:8443/x").origin).toBe(
      "https://api.example.com:8443",
    );
  });

  it("lowercases the host", () => {
    expect(normalizeServerUrl("https://API.Example.COM").origin).toBe("https://api.example.com");
  });

  it.each([
    ["http://localhost:3000", "http://localhost:3000", "http://localhost/*"],
    ["http://127.0.0.1:3000/", "http://127.0.0.1:3000", "http://127.0.0.1/*"],
    ["http://[::1]:3000", "http://[::1]:3000", "http://[::1]/*"],
  ])("allows plain http for loopback host %s (pattern has no port)", (inp, origin, pattern) => {
    expect(normalizeServerUrl(inp)).toEqual({ origin, originPattern: pattern });
  });

  it("omits the port from the permission pattern (match patterns ignore ports)", () => {
    expect(normalizeServerUrl("https://api.example.com:8443").originPattern).toBe(
      "https://api.example.com/*",
    );
  });

  it.each(["http://api.example.com", "http://192.168.1.5:3000", "http://localhost.evil.com"])(
    "rejects plain http to non-loopback host %s as insecure",
    (bad) => {
      expect(codeOfSync(() => normalizeServerUrl(bad))).toBe("server_url_insecure");
    },
  );

  it.each([
    "",
    "   ",
    "not a url",
    "api.example.com",
    "ftp://example.com",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "chrome://settings",
    "https://",
    "https://*",
    "https://*.example.com",
    "https://ex%2a.com",
  ])("rejects %j as an invalid server URL", (bad) => {
    expect(codeOfSync(() => normalizeServerUrl(bad))).toBe("server_url_invalid");
  });
});

describe("connect: permission and user-gesture ordering", () => {
  it("calls permissions.request synchronously, before any other await (Firefox user gesture)", () => {
    const { deps } = makeDeps();
    const p = connect(input, deps);
    p.catch(() => {});
    // No await between calling connect() and these assertions.
    expect(deps.permissions.request).toHaveBeenCalledTimes(1);
    expect(deps.permissions.request).toHaveBeenCalledWith({
      origins: ["https://api.example.com/*"],
    });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.storage.get).not.toHaveBeenCalled();
    expect(deps.storage.set).not.toHaveBeenCalled();
  });

  it("requests the permission for the normalized origin, not the typed path", async () => {
    const { deps } = makeDeps();
    await connect({ ...input, serverUrl: "https://api.example.com/app?x=1#y" }, deps);
    expect(deps.permissions.request).toHaveBeenCalledWith({
      origins: ["https://api.example.com/*"],
    });
  });

  it("asks for permission before fetching and fetches before storing", async () => {
    const { deps, calls } = makeDeps();
    await connect(input, deps);
    expect(calls[0]).toBe("permissions.request");
    expect(calls.indexOf("fetch")).toBeGreaterThan(calls.indexOf("permissions.request"));
    expect(calls.indexOf("storage.set")).toBeGreaterThan(calls.indexOf("fetch"));
  });

  it("fails with permission_denied and sends no request when the user denies the permission", async () => {
    const { deps } = makeDeps();
    deps.permissions.request.mockResolvedValueOnce(false);
    const err = await errorOf(connect(input, deps));
    expect(err.code).toBe("permission_denied");
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.storage.set).not.toHaveBeenCalled();
  });

  it("treats a rejected permissions.request as permission_denied", async () => {
    const { deps } = makeDeps();
    deps.permissions.request.mockRejectedValueOnce(new Error("boom"));
    const err = await errorOf(connect(input, deps));
    expect(err.code).toBe("permission_denied");
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("rejects an invalid or insecure URL without requesting permission or fetching", async () => {
    for (const [serverUrl, code] of [
      ["garbage", "server_url_invalid"],
      ["http://api.example.com", "server_url_insecure"],
    ] as const) {
      const { deps } = makeDeps();
      const err = await errorOf(connect({ ...input, serverUrl }, deps));
      expect(err.code).toBe(code);
      expect(deps.permissions.request).not.toHaveBeenCalled();
      expect(deps.fetch).not.toHaveBeenCalled();
    }
  });

  it("rejects a blank pairing code without requesting permission or fetching", async () => {
    const { deps } = makeDeps();
    const err = await errorOf(connect({ ...input, pairingCode: "   " }, deps));
    expect(err.code).toBe("pairing_code_empty");
    expect(deps.permissions.request).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});

describe("connect: the pairing request", () => {
  it("POSTs to <origin>/v1/pair with a JSON body of exactly {pairingCode}", async () => {
    const { deps } = makeDeps();
    await connect({ ...input, serverUrl: "https://api.example.com/ignored/" }, deps);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = deps.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/pair");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ pairingCode: CODE });
    expect(Object.keys(JSON.parse(init.body as string))).toEqual(["pairingCode"]);
    expect(new Headers(init.headers).get("content-type")).toContain("application/json");
  });

  it("sends no cookies or credentials, sends no auth header, and refuses redirects", async () => {
    const { deps } = makeDeps();
    await connect(input, deps);
    const [, init] = deps.fetch.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
  });

  it("trims the pairing code before sending", async () => {
    const { deps } = makeDeps();
    await connect({ ...input, pairingCode: `  ${CODE}\n` }, deps);
    const [, init] = deps.fetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ pairingCode: CODE });
  });
});

describe("connect: success", () => {
  it("returns the connection and stores it under one storage key in a single set call", async () => {
    const { deps, store } = makeDeps();
    const expected = {
      serverOrigin: "https://api.example.com",
      ingestKey: KEY,
      integrationId: INTEGRATION_ID,
      integrationName: "Work laptop",
    };
    const result = await connect(input, deps);
    expect(result).toEqual(expected);
    expect(deps.storage.set).toHaveBeenCalledTimes(1);
    expect(deps.storage.set).toHaveBeenCalledWith({ [CONNECTION_STORAGE_KEY]: expected });
    expect(Object.keys(store)).toEqual([CONNECTION_STORAGE_KEY]);
  });

  it("makes getConnection return what connect stored", async () => {
    const { deps } = makeDeps();
    const c = await connect(input, deps);
    expect(await getConnection(deps)).toEqual(c);
  });

  it("never stores the pairing code", async () => {
    const { deps, store } = makeDeps();
    await connect(input, deps);
    expect(JSON.stringify(store)).not.toContain(CODE);
  });
});

describe("connect: failures map to distinct typed errors and store nothing", () => {
  const cases: Array<{ name: string; code: string; res: () => Promise<Response> | Response }> = [
    {
      name: "pairing.code_invalid (400)",
      code: "code_invalid",
      res: () => json({ status: 400, code: "pairing.code_invalid" }, 400),
    },
    {
      name: "pairing.code_invalid (404)",
      code: "code_invalid",
      res: () => json({ status: 404, code: "pairing.code_invalid" }, 404),
    },
    {
      name: "pairing.integration_not_pairable",
      code: "not_pairable",
      res: () => json({ status: 409, code: "pairing.integration_not_pairable" }, 409),
    },
    {
      name: "a 500 with problem+json",
      code: "server_error",
      res: () => json({ status: 500, code: "internal" }, 500),
    },
    {
      name: "a 502 with an HTML body",
      code: "server_error",
      res: () => new Response("<html>bad gateway</html>", { status: 502 }),
    },
    {
      name: "a 200 that is not JSON",
      code: "bad_response",
      res: () => new Response("<html>hi</html>", { status: 200 }),
    },
    {
      name: "a 200 that fails pairResponseSchema",
      code: "bad_response",
      res: () => json({ ingestKey: { key: KEY } }),
    },
    {
      name: "a 200 with an unknown extra field (strict schema)",
      code: "bad_response",
      res: () => json({ ...pairBody, extra: 1 }),
    },
    {
      name: "a fetch network failure",
      code: "network",
      res: () => Promise.reject(new TypeError("Failed to fetch")),
    },
  ];

  it.each(cases)("$name -> $code, nothing stored", async ({ code, res }) => {
    const { deps, store } = makeDeps();
    deps.fetch.mockImplementationOnce(async () => res());
    const err = await errorOf(connect(input, deps));
    expect(err.code).toBe(code);
    expect(err.message.length).toBeGreaterThan(0);
    expect(deps.storage.set).not.toHaveBeenCalled();
    expect(store).toEqual({});
  });

  it("maps pairing.rate_limited (429) to rate_limited and surfaces Retry-After seconds", async () => {
    const { deps, store } = makeDeps();
    deps.fetch.mockResolvedValueOnce(
      json({ status: 429, code: "pairing.rate_limited" }, 429, { "retry-after": "42" }),
    );
    const err = await errorOf(connect(input, deps));
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfterSeconds).toBe(42);
    expect(err.message).toContain("42");
    expect(store).toEqual({});
  });

  it("still reports rate_limited when Retry-After is missing, with no retryAfterSeconds", async () => {
    const { deps } = makeDeps();
    deps.fetch.mockResolvedValueOnce(json({ status: 429, code: "pairing.rate_limited" }, 429));
    const err = await errorOf(connect(input, deps));
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it("does not overwrite an existing connection when pairing fails", async () => {
    const { deps, store } = makeDeps();
    await connect(input, deps);
    const before = structuredClone(store);
    deps.fetch.mockResolvedValueOnce(json({ code: "pairing.code_invalid" }, 400));
    await errorOf(connect(input, deps));
    expect(store).toEqual(before);
  });

  it("never puts the pairing code or the key in an error message, or in console output", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const failures: Array<() => Promise<Response>> = [
      async () => json({ code: "pairing.code_invalid", detail: `bad ${CODE} ${KEY}` }, 400),
      async () => json({ code: "pairing.rate_limited" }, 429, { "retry-after": "5" }),
      async () => new Response(`${CODE} ${KEY}`, { status: 200 }),
      async () => json({ ...pairBody, extra: KEY }),
      async () => {
        throw new TypeError(`network down for ${CODE} ${KEY}`);
      },
    ];
    for (const f of failures) {
      const { deps } = makeDeps();
      deps.fetch.mockImplementationOnce(async () => f());
      const err = await errorOf(connect(input, deps));
      expect(err.message).not.toContain(CODE);
      expect(err.message).not.toContain(KEY);
      expect(String(err.cause ?? "")).not.toContain(KEY);
    }
    // The success path logs nothing sensitive either.
    await connect(input, makeDeps().deps);
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(CODE);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
    }
  });
});

describe("getConnection", () => {
  const valid = {
    serverOrigin: "https://api.example.com",
    ingestKey: KEY,
    integrationId: INTEGRATION_ID,
    integrationName: "Work laptop",
  };

  it("returns null when nothing is stored", async () => {
    expect(await getConnection(makeDeps().deps)).toBeNull();
  });

  it("returns a valid stored connection", async () => {
    const { deps, store } = makeDeps();
    store[CONNECTION_STORAGE_KEY] = valid;
    expect(await getConnection(deps)).toEqual(valid);
  });

  it.each([
    ["a string", "garbage"],
    ["null", null],
    ["an array", [valid]],
    ["a missing ingestKey", { ...valid, ingestKey: undefined }],
    ["a non-string ingestKey", { ...valid, ingestKey: 5 }],
    ["an empty ingestKey", { ...valid, ingestKey: "" }],
    ["a key without the pa_ing_ prefix", { ...valid, ingestKey: "pa_read_abc" }],
    ["a missing serverOrigin", { ...valid, serverOrigin: undefined }],
    ["a non-http(s) serverOrigin", { ...valid, serverOrigin: "ftp://x.example.com" }],
    ["an unparseable serverOrigin", { ...valid, serverOrigin: "nope" }],
    ["a non-uuid integrationId", { ...valid, integrationId: "123" }],
    ["a missing integrationName", { ...valid, integrationName: undefined }],
  ])("treats %s as not connected (fail closed)", async (_n, stored) => {
    const { deps, store } = makeDeps();
    store[CONNECTION_STORAGE_KEY] = stored;
    expect(await getConnection(deps)).toBeNull();
  });

  it("treats a throwing storage.get as not connected", async () => {
    const { deps } = makeDeps();
    deps.storage.get.mockRejectedValueOnce(new Error("storage unavailable"));
    expect(await getConnection(deps)).toBeNull();
  });
});

describe("disconnect", () => {
  it("removes the stored connection and the origin permission", async () => {
    const { deps, store } = makeDeps();
    await connect(input, deps);
    await disconnect(deps);
    expect(store[CONNECTION_STORAGE_KEY]).toBeUndefined();
    expect(deps.storage.remove).toHaveBeenCalledWith(CONNECTION_STORAGE_KEY);
    expect(deps.permissions.remove).toHaveBeenCalledWith({
      origins: ["https://api.example.com/*"],
    });
    expect(await getConnection(deps)).toBeNull();
  });

  it("still clears the connection when permissions.remove rejects (best effort)", async () => {
    const { deps, store } = makeDeps();
    await connect(input, deps);
    deps.permissions.remove.mockRejectedValueOnce(new Error("cannot remove"));
    await expect(disconnect(deps)).resolves.toBeUndefined();
    expect(store[CONNECTION_STORAGE_KEY]).toBeUndefined();
  });

  it("is idempotent when not connected and does not touch permissions", async () => {
    const { deps } = makeDeps();
    await expect(disconnect(deps)).resolves.toBeUndefined();
    await expect(disconnect(deps)).resolves.toBeUndefined();
    expect(deps.permissions.remove).not.toHaveBeenCalled();
  });

  it("clears corrupted stored data too", async () => {
    const { deps, store } = makeDeps();
    store[CONNECTION_STORAGE_KEY] = { serverOrigin: 5 };
    await expect(disconnect(deps)).resolves.toBeUndefined();
    expect(store[CONNECTION_STORAGE_KEY]).toBeUndefined();
  });

  it("makes no network request", async () => {
    const { deps } = makeDeps();
    await connect(input, deps);
    deps.fetch.mockClear();
    await disconnect(deps);
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});

describe("connect: rules (M4-06)", () => {
  it("fetches the rules once the pairing is stored, not before", async () => {
    const { deps, store } = makeDeps();
    const seen: unknown[] = [];
    const syncRules = vi.fn(async () => {
      seen.push(store[CONNECTION_STORAGE_KEY]);
    });
    await connect(input, { ...deps, syncRules });
    expect(syncRules).toHaveBeenCalledTimes(1);
    expect(seen[0]).toMatchObject({ ingestKey: KEY });
  });

  it("does not fetch rules when the pairing fails", async () => {
    const { deps } = makeDeps();
    deps.fetch.mockResolvedValueOnce(json({ code: "pairing.code_invalid" }, 400));
    const syncRules = vi.fn(async () => undefined);
    await errorOf(connect(input, { ...deps, syncRules }));
    expect(syncRules).not.toHaveBeenCalled();
  });

  it("is still connected when the rules fetch rejects (the periodic sync retries)", async () => {
    const { deps, store } = makeDeps();
    const syncRules = vi.fn(async () => {
      throw new Error("offline");
    });
    const connection = await connect(input, { ...deps, syncRules });
    expect(connection.ingestKey).toBe(KEY);
    expect(store[CONNECTION_STORAGE_KEY]).toBeDefined();
  });

  it("disconnect removes the fetched rules too", async () => {
    const { deps, store } = makeDeps();
    await connect(input, deps);
    store.rulesConfig = { owner: {}, etag: '"x"', config: {} };
    await disconnect(deps);
    expect(store.rulesConfig).toBeUndefined();
    expect(store[CONNECTION_STORAGE_KEY]).toBeUndefined();
  });
});
