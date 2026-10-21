/**
 * M9-01: saved-query endpoints and read keys are gone. The routes answer 404 whatever credential
 * comes with them (so nothing says "this used to exist" or "that key was valid"), and the routes
 * that used to take a read key (`/v1/events`, `/v1/activity/*`) now take a dashboard session only.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FORMER_READ_KEY } from "../../../test/former-read-key";
import { type IngestHarness, PROBLEM_JSON, startIngestHarness } from "../../../test/ingest-helpers";

let h: IngestHarness;

beforeAll(async () => {
  h = await startIngestHarness();
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

const http = () => request(h.app.getHttpServer());
const MISSING_ID = "0192f1c2-7c1e-7a3b-9f00-000000000000";

type Method = "GET" | "POST" | "PUT" | "DELETE";

const REMOVED: ReadonlyArray<readonly [Method, string]> = [
  ["GET", "/v1/keys"],
  ["POST", "/v1/keys"],
  ["POST", `/v1/keys/${MISSING_ID}/revoke`],
  ["GET", "/v1/endpoints"],
  ["POST", "/v1/endpoints"],
  ["POST", "/v1/endpoints/preview"],
  ["GET", `/v1/endpoints/${MISSING_ID}`],
  ["PUT", `/v1/endpoints/${MISSING_ID}`],
  ["DELETE", `/v1/endpoints/${MISSING_ID}`],
  ["POST", `/v1/endpoints/${MISSING_ID}/rotate-key`],
  ["GET", "/v1/me/stats"],
];

function send(method: Method, path: string) {
  const agent = http();
  switch (method) {
    case "GET":
      return agent.get(path);
    case "POST":
      return agent.post(path);
    case "PUT":
      return agent.put(path);
    case "DELETE":
      return agent.delete(path);
  }
}

describe("the removed routes answer 404 for every credential", () => {
  const credentials: Array<[string, (req: request.Test) => request.Test]> = [
    ["no credential", (req) => req],
    ["a dashboard session", (req) => req.set("Cookie", h.a.cookie)],
    ["an ingest key", (req) => req.set("Authorization", `Bearer ${h.a.ingestKey}`)],
    ["a former read key", (req) => req.set("Authorization", `Bearer ${FORMER_READ_KEY}`)],
  ];

  for (const [method, path] of REMOVED) {
    for (const [label, apply] of credentials) {
      it(`${method} ${path.replace(MISSING_ID, ":id")} with ${label}`, async () => {
        const res = await apply(send(method, path)).send({});
        expect(res.status, JSON.stringify(res.body)).toBe(404);
        expect(String(res.headers["content-type"])).toMatch(PROBLEM_JSON);
      });
    }
  }
});

describe("events and activity take a dashboard session only", () => {
  const READ_ROUTES = ["/v1/events", "/v1/activity/daily", "/v1/activity/domains"];

  it.each(READ_ROUTES)(
    "%s refuses a former read key with 401 auth.unauthenticated",
    async (path) => {
      const res = await http().get(path).set("Authorization", `Bearer ${FORMER_READ_KEY}`);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("auth.unauthenticated");
      expect(String(res.headers["content-type"])).toMatch(PROBLEM_JSON);
    },
  );

  it.each(READ_ROUTES)("%s refuses an ingest key with 401 auth.unauthenticated", async (path) => {
    const res = await http().get(path).set("Authorization", `Bearer ${h.a.ingestKey}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("auth.unauthenticated");
  });

  it.each(READ_ROUTES)("%s still answers a dashboard session", async (path) => {
    const res = await http().get(path).set("Cookie", h.a.cookie);
    expect(res.status).toBe(200);
  });

  it("a bearer never replaces the session: the cookie decides, the header is ignored", async () => {
    const res = await http()
      .get("/v1/events")
      .set("Cookie", h.b.cookie)
      .set("Authorization", `Bearer ${FORMER_READ_KEY}`);
    expect(res.status).toBe(200);
  });
});
