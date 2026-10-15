/**
 * M2-01 pairing against a real database (Testcontainers; CI runs these). The real application,
 * the two-user fixture and a fake clock, driven over HTTP.
 *
 * Done when: tests cover expired, reused and brute-force-throttled codes (and the rest of the
 * contract: single use under concurrency, no oracle between failure reasons, only hashes stored,
 * tenant scoping, no secret in the logs).
 */
import { createHash } from "node:crypto";
import {
  createIntegrationResponseSchema,
  PAIRING_CODE_INVALID_CODE,
  PAIRING_CODE_TTL_MS,
  PAIRING_NOT_PAIRABLE_CODE,
  PAIRING_RATE_LIMITED_CODE,
  pairResponseSchema,
} from "@personal-api/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { captureOutput } from "../../../test/auth.helpers";
import {
  expectResults,
  FIXED_NOW,
  type IngestHarness,
  PROBLEM_JSON,
  pageVisit,
  postEvents,
  startIngestHarness,
} from "../../../test/ingest-helpers";
import {
  createExtension,
  issueCode,
  keyCount,
  PAIR_PATH,
  pair,
  pairingRows,
  requestCode,
} from "../../../test/pairing-helpers";
import { PAIR_ATTEMPTS_PER_WINDOW, PAIR_WINDOW_MS } from "./pair-rate-limit.guard";
import { generatePairingCode } from "./pairing-code";

let h: IngestHarness;

beforeAll(async () => {
  h = await startIngestHarness();
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.reset();
});

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const http = () => request(h.app.getHttpServer());

/** A fresh extension integration for user A and a live code for it. */
async function codeForA() {
  const integrationId = await createExtension(h.app, h.a);
  const issued = await issueCode(h.app, h.a, integrationId);
  return { integrationId, ...issued };
}

function expectInvalid(res: { status: number; headers: Record<string, unknown>; body: unknown }) {
  expect(res.status, JSON.stringify(res.body)).toBe(400);
  expect(String(res.headers["content-type"])).toMatch(PROBLEM_JSON);
  expect((res.body as { code: string }).code).toBe(PAIRING_CODE_INVALID_CODE);
}

describe("creating a browser-extension integration", () => {
  it("returns the integration with no key and stores no key for it", async () => {
    const res = await http()
      .post("/v1/integrations")
      .set("Cookie", h.a.cookie)
      .send({ kind: "browser-extension", name: "Work Edge" });
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(res.body)).toEqual(["integration"]);
    expect(res.body.integration).toMatchObject({
      kind: "browser-extension",
      name: "Work Edge",
      defaultPolicy: "deny",
      status: "active",
    });
    expect(await keyCount(h.testDb.pool, res.body.integration.id)).toBe(0);
  });

  it("still gives an http integration its key at creation", async () => {
    const res = await http()
      .post("/v1/integrations")
      .set("Cookie", h.a.cookie)
      .send({ kind: "http", name: "Script" });
    expect(res.status).toBe(201);
    expect(createIntegrationResponseSchema.parse(res.body).ingestKey.key).toMatch(/^pa_ing_/);
  });
});

describe("POST /v1/integrations/:id/pairing-code", () => {
  it("issues a one-time code that expires in 10 minutes, and stores only its hash", async () => {
    const integrationId = await createExtension(h.app, h.a);
    const res = await requestCode(h.app, h.a, integrationId);
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(res.body).sort()).toEqual(["expiresAt", "pairingCode"]);
    expect(res.body.pairingCode).toMatch(/^([0-9A-Z]{4}-){4}[0-9A-Z]{4}$/);
    expect(res.body.expiresAt).toBe(
      new Date(Date.parse(FIXED_NOW) + PAIRING_CODE_TTL_MS).toISOString(),
    );

    const rows = await pairingRows(h.testDb.pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: h.a.userId,
      integration_id: integrationId,
      code_hash: sha256(res.body.pairingCode.replaceAll("-", "")),
      used_at: null,
    });
    expect(rows[0]?.expires_at.toISOString()).toBe(res.body.expiresAt);
    expect(JSON.stringify(rows)).not.toContain(res.body.pairingCode);
    expect(JSON.stringify(rows)).not.toContain(res.body.pairingCode.replaceAll("-", ""));
  });

  it("invalidates the integration's earlier unused codes when a new one is issued", async () => {
    const integrationId = await createExtension(h.app, h.a);
    const first = await issueCode(h.app, h.a, integrationId);
    const second = await issueCode(h.app, h.a, integrationId);
    expect(await pairingRows(h.testDb.pool, integrationId)).toHaveLength(1);

    expectInvalid(await pair(h.app, { pairingCode: first.pairingCode }));
    const res = await pair(h.app, { pairingCode: second.pairingCode });
    expect(res.status).toBe(200);
  });

  it("leaves a used code in place when a new one is issued", async () => {
    const { integrationId, pairingCode } = await codeForA();
    expect((await pair(h.app, { pairingCode })).status).toBe(200);
    await issueCode(h.app, h.a, integrationId);
    const rows = await pairingRows(h.testDb.pool, integrationId);
    expect(rows.map((r) => r.used_at !== null).sort()).toEqual([false, true]);
  });

  it("refuses an http integration and a revoked extension with 409, issuing nothing", async () => {
    const extension = await createExtension(h.app, h.a);
    expect(
      (await http().post(`/v1/integrations/${extension}/revoke`).set("Cookie", h.a.cookie)).status,
    ).toBe(200);
    for (const id of [h.a.integrationId, extension]) {
      const res = await requestCode(h.app, h.a, id);
      expect(res.status).toBe(409);
      expect(String(res.headers["content-type"])).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe(PAIRING_NOT_PAIRABLE_CODE);
    }
    expect(await pairingRows(h.testDb.pool)).toEqual([]);
  });

  it("answers an unknown or malformed id with 404 integration.not_found", async () => {
    for (const id of ["0192f1c2-7c1e-7a3b-9f00-000000000000", "not-a-uuid", "' or 1=1 --"]) {
      const res = await requestCode(h.app, h.a, encodeURIComponent(id));
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("integration.not_found");
    }
  });

  it("is session-only: no credential, an ingest key or a read key is a 401", async () => {
    const integrationId = await createExtension(h.app, h.a);
    const path = `/v1/integrations/${integrationId}/pairing-code`;
    for (const auth of [undefined, `Bearer ${h.a.ingestKey}`, "Bearer pa_read_x"]) {
      let req = http().post(path);
      if (auth) req = req.set("Authorization", auth);
      const res = await req;
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("auth.unauthenticated");
    }
    expect(await pairingRows(h.testDb.pool)).toEqual([]);
  });
});

describe("POST /v1/pair", () => {
  it("exchanges a code for an ingest key that can ingest, and shows the key once", async () => {
    const { integrationId, pairingCode } = await codeForA();
    const res = await pair(h.app, { pairingCode });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const paired = pairResponseSchema.parse(res.body);
    expect(paired.integration).toMatchObject({
      id: integrationId,
      kind: "browser-extension",
      defaultPolicy: "deny",
      status: "active",
    });
    expect(paired.ingestKey.key).toMatch(/^pa_ing_[A-Za-z0-9_-]{43}$/);

    // The key is stored as a hash, for this integration and this user, and it works.
    const { rows } = await h.testDb.pool.query(
      "select user_id, kind, integration_id, hash, prefix, revoked_at from api_keys where id = $1",
      [paired.ingestKey.id],
    );
    expect(rows).toEqual([
      {
        user_id: h.a.userId,
        kind: "ingest",
        integration_id: integrationId,
        hash: sha256(paired.ingestKey.key),
        prefix: paired.ingestKey.prefix,
        revoked_at: null,
      },
    ]);
    expectResults(await postEvents(h.app, paired.ingestKey.key, [pageVisit()]));
    const { rows: events } = await h.testDb.pool.query(
      "select user_id, integration_id from events where integration_id = $1",
      [integrationId],
    );
    expect(events).toEqual([{ user_id: h.a.userId, integration_id: integrationId }]);
  });

  it("marks the code used with the clock time", async () => {
    const { integrationId, pairingCode } = await codeForA();
    h.clock.advance(5_000);
    await pair(h.app, { pairingCode });
    const [row] = await pairingRows(h.testDb.pool, integrationId);
    expect(row?.used_at?.toISOString()).toBe(new Date(Date.parse(FIXED_NOW) + 5_000).toISOString());
  });

  it("accepts the code without dashes, in lower case and with surrounding spaces", async () => {
    const { pairingCode } = await codeForA();
    const res = await pair(h.app, {
      pairingCode: `  ${pairingCode.replaceAll("-", "").toLowerCase()} `,
    });
    expect(res.status).toBe(200);
  });

  describe("single use", () => {
    it("rejects a second use of the same code and mints no second key", async () => {
      const { integrationId, pairingCode } = await codeForA();
      expect((await pair(h.app, { pairingCode })).status).toBe(200);
      expectInvalid(await pair(h.app, { pairingCode }));
      expect(await keyCount(h.testDb.pool, integrationId)).toBe(1);
    });

    it("lets exactly one of two simultaneous redemptions win", async () => {
      const { integrationId, pairingCode } = await codeForA();
      const results = await Promise.all([
        pair(h.app, { pairingCode }),
        pair(h.app, { pairingCode }),
        pair(h.app, { pairingCode }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
      for (const loser of results.filter((r) => r.status !== 200)) expectInvalid(loser);
      expect(await keyCount(h.testDb.pool, integrationId)).toBe(1);
    });
  });

  describe("expiry (fixed clock)", () => {
    it("accepts a code up to the last millisecond before expiry", async () => {
      const { pairingCode } = await codeForA();
      h.clock.advance(PAIRING_CODE_TTL_MS - 1);
      expect((await pair(h.app, { pairingCode })).status).toBe(200);
    });

    it("rejects a code at exactly 10 minutes, and after", async () => {
      const exact = await codeForA();
      const later = await codeForA();
      h.clock.advance(PAIRING_CODE_TTL_MS);
      expectInvalid(await pair(h.app, { pairingCode: exact.pairingCode }));
      h.clock.advance(60 * 60 * 1000);
      expectInvalid(await pair(h.app, { pairingCode: later.pairingCode }));
      expect(await keyCount(h.testDb.pool, exact.integrationId)).toBe(0);
      expect(await keyCount(h.testDb.pool, later.integrationId)).toBe(0);
    });

    it("leaves an expired code unused", async () => {
      const { integrationId, pairingCode } = await codeForA();
      h.clock.advance(PAIRING_CODE_TTL_MS);
      await pair(h.app, { pairingCode });
      const [row] = await pairingRows(h.testDb.pool, integrationId);
      expect(row?.used_at).toBeNull();
    });
  });

  describe("revoked integration", () => {
    it("rejects a live code once its integration is revoked, with no key stored", async () => {
      const { integrationId, pairingCode } = await codeForA();
      expect(
        (await http().post(`/v1/integrations/${integrationId}/revoke`).set("Cookie", h.a.cookie))
          .status,
      ).toBe(200);
      expectInvalid(await pair(h.app, { pairingCode }));
      expect(await keyCount(h.testDb.pool, integrationId)).toBe(0);
    });
  });

  describe("no oracle between failure reasons", () => {
    it("gives byte-identical answers for unknown, malformed, expired, used, superseded and revoked", async () => {
      // Expired first: it is issued, then the clock moves past its 10 minutes. Every other code is
      // issued after that, so each failure below has exactly one cause.
      const expired = await codeForA();
      h.clock.advance(PAIRING_CODE_TTL_MS);

      const used = await codeForA();
      expect((await pair(h.app, { pairingCode: used.pairingCode })).status).toBe(200);

      const superseded = await codeForA();
      await issueCode(h.app, h.a, superseded.integrationId);

      const revoked = await codeForA();
      await http()
        .post(`/v1/integrations/${revoked.integrationId}/revoke`)
        .set("Cookie", h.a.cookie);

      const attempts = [
        ["unknown", generatePairingCode().display],
        ["malformed", "hello"],
        ["too long", "A".repeat(63)],
        ["expired", expired.pairingCode],
        ["used", used.pairingCode],
        ["superseded", superseded.pairingCode],
        ["revoked", revoked.pairingCode],
      ] as const;
      const responses = [];
      for (const [, pairingCode] of attempts) responses.push(await pair(h.app, { pairingCode }));
      for (const res of responses) expectInvalid(res);
      const [first, ...rest] = responses;
      for (const res of rest) expect(res.body).toEqual(first?.body);
    });
  });

  describe("the body names nothing but the code", () => {
    it("rejects a userId or integrationId in the body with request.invalid and stores nothing", async () => {
      const { pairingCode } = await codeForA();
      for (const extra of [
        { userId: h.b.userId },
        { integrationId: h.b.integrationId },
        { userId: h.b.userId, integrationId: h.b.integrationId },
      ]) {
        const res = await pair(h.app, { pairingCode, ...extra });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("request.invalid");
        expect(JSON.stringify(res.body)).not.toContain(h.b.userId);
      }
      const { rows } = await h.testDb.pool.query(
        "select count(*)::int as n from api_keys where user_id = $1",
        [h.b.userId],
      );
      expect(rows[0].n).toBe(1); // B's fixture key, nothing new
    });

    it("takes the owner from the code's row: naming B in query and headers still pairs A", async () => {
      const { integrationId, pairingCode } = await codeForA();
      const res = await http()
        .post(`${PAIR_PATH}?userId=${h.b.userId}&integrationId=${h.b.integrationId}`)
        .set("X-User-Id", h.b.userId)
        .set("X-Integration-Id", h.b.integrationId)
        .send({ pairingCode });
      expect(res.status).toBe(200);
      expect(res.body.integration.id).toBe(integrationId);
      const { rows } = await h.testDb.pool.query("select user_id from api_keys where id = $1", [
        res.body.ingestKey.id,
      ]);
      expect(rows).toEqual([{ user_id: h.a.userId }]);
    });

    it("answers a missing, empty or non-string code with request.invalid", async () => {
      for (const body of [{}, { pairingCode: "" }, { pairingCode: 5 }, { pairingCode: ["x"] }]) {
        const res = await pair(h.app, body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("request.invalid");
      }
    });
  });

  describe("brute-force throttle", () => {
    const wrong = () => pair(h.app, { pairingCode: generatePairingCode().display });

    it("answers 429 pairing.rate_limited with Retry-After after 10 attempts from one address", async () => {
      for (let i = 0; i < PAIR_ATTEMPTS_PER_WINDOW; i++) expectInvalid(await wrong());
      const res = await wrong();
      expect(res.status).toBe(429);
      expect(String(res.headers["content-type"])).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe(PAIRING_RATE_LIMITED_CODE);
      expect(res.headers["retry-after"]).toBe("60");
    });

    it("refuses even a valid code once throttled, and leaves it unspent for later", async () => {
      const { integrationId, pairingCode } = await codeForA();
      for (let i = 0; i < PAIR_ATTEMPTS_PER_WINDOW; i++) await wrong();
      const throttled = await pair(h.app, { pairingCode });
      expect(throttled.status).toBe(429);
      expect(throttled.body.code).toBe(PAIRING_RATE_LIMITED_CODE);
      expect(JSON.stringify(throttled.body)).not.toContain("ingestKey");
      const [row] = await pairingRows(h.testDb.pool, integrationId);
      expect(row?.used_at).toBeNull();
      expect(await keyCount(h.testDb.pool, integrationId)).toBe(0);

      h.clock.advance(PAIR_WINDOW_MS);
      expect((await pair(h.app, { pairingCode })).status).toBe(200);
    });

    it("counts a malformed body too, and ignores a forged X-Forwarded-For", async () => {
      for (let i = 0; i < PAIR_ATTEMPTS_PER_WINDOW; i++) {
        const res = await http().post(PAIR_PATH).set("X-Forwarded-For", `198.51.100.${i}`).send({});
        expect(res.status).toBe(400);
      }
      const res = await http()
        .post(PAIR_PATH)
        .set("X-Forwarded-For", "203.0.113.99")
        .send({ pairingCode: generatePairingCode().display });
      expect(res.status).toBe(429);
    });

    it("counts a successful pairing as an attempt", async () => {
      for (let i = 0; i < PAIR_ATTEMPTS_PER_WINDOW; i++) {
        const { pairingCode } = await codeForA();
        expect((await pair(h.app, { pairingCode })).status).toBe(200);
      }
      expect((await wrong()).status).toBe(429);
    });
  });

  it("is reachable without any credential and ignores one if sent", async () => {
    const { pairingCode } = await codeForA();
    const res = await http()
      .post(PAIR_PATH)
      .set("Authorization", "Bearer pa_read_garbage")
      .set("Cookie", "better-auth.session_token=garbage")
      .send({ pairingCode });
    expect(res.status).toBe(200);
  });
});

describe("tenant scoping", () => {
  it("answers B asking for a code on A's extension exactly like an unknown id, and changes nothing", async () => {
    const aExtension = await createExtension(h.app, h.a);
    await issueCode(h.app, h.a, aExtension);
    const before = await pairingRows(h.testDb.pool);

    const foreign = await requestCode(h.app, h.b, aExtension);
    const unknown = await requestCode(h.app, h.b, "0192f1c2-7c1e-7a3b-9f00-000000000000");
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe("integration.not_found");
    expect(foreign.status).toBe(unknown.status);
    expect(foreign.body).toEqual(unknown.body);
    expect(await pairingRows(h.testDb.pool)).toEqual(before);
  });

  it("does not let B's request supersede A's pending code", async () => {
    const { integrationId, pairingCode } = await codeForA();
    await requestCode(h.app, h.b, integrationId);
    expect((await pair(h.app, { pairingCode })).status).toBe(200);
  });

  it("a code issued for A's integration pairs A's integration only, and B's data is untouched", async () => {
    const bExtension = await createExtension(h.app, h.b);
    const { integrationId, pairingCode } = await codeForA();
    const res = await pair(h.app, { pairingCode });
    expect(res.body.integration.id).toBe(integrationId);
    expect(await keyCount(h.testDb.pool, bExtension)).toBe(0);
  });
});

describe("secrets in logs", () => {
  it("never writes a pairing code or an ingest key to the process output", async () => {
    const capture = captureOutput();
    let output: string;
    let secrets: string[] = [];
    try {
      const { pairingCode } = await codeForA();
      const res = await pair(h.app, { pairingCode });
      await pair(h.app, { pairingCode }); // a rejected attempt is logged too
      secrets = [pairingCode, pairingCode.replaceAll("-", ""), res.body.ingestKey.key];
    } finally {
      output = capture.stop();
    }
    expect(secrets).toHaveLength(3);
    expect(output.length).toBeGreaterThan(0);
    for (const secret of secrets) expect(output).not.toContain(secret);
  });
});
