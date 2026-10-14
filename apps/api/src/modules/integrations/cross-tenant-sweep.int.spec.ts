/**
 * M1-07 cross-tenant sweep: every M1 route (`/v1/me`, integrations create/list/get/rename/revoke,
 * ingest events, ingest heartbeat) is attacked by user A against user B and by B against A, in one
 * table. One oracle for every row: the victim's state (integrations, keys, events, counters) is
 * deep-equal before and after, the answer is the specific refusal (not a bare status), and the
 * owner making the same call succeeds (so a typo'd path cannot pass as "denied").
 *
 * A last block checks the table against the routes Nest actually registers under /v1, so a new
 * route cannot be forgotten, and that every route refuses a missing or wrong-kind credential.
 */
import { randomUUID } from "node:crypto";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ModulesContainer } from "@nestjs/core";
import {
  createIntegrationResponseSchema,
  integrationListResponseSchema,
} from "@personal-api/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createViaRoute,
  HEARTBEAT_PATH,
  heartbeatBody,
  postHeartbeat,
  tenantState,
} from "../../../test/adversarial-helpers";
import {
  eventRows,
  expectResults,
  INGEST_PATH,
  type IngestHarness,
  PROBLEM_JSON,
  pageVisit,
  postEvents,
  startIngestHarness,
} from "../../../test/ingest-helpers";
import type { FixtureUser } from "../../../test/two-user-fixture";
import { generateApiKey } from "../keys/key-generation";

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

const http = () => request(h.app.getHttpServer());
const cookieGet = (u: FixtureUser, path: string) => http().get(path).set("Cookie", u.cookie);
const cookiePost = (u: FixtureUser, path: string, body?: unknown) =>
  http()
    .post(path)
    .set("Cookie", u.cookie)
    .send(body as object);
const cookiePatch = (u: FixtureUser, path: string, body?: unknown) =>
  http()
    .patch(path)
    .set("Cookie", u.cookie)
    .send(body as object);
const keyPost = (u: FixtureUser, path: string, body: unknown, query = "") =>
  http()
    .post(`${path}${query}`)
    .set("Authorization", `Bearer ${u.ingestKey}`)
    .send(body as object);

type Res = Awaited<ReturnType<typeof cookieGet>>;

const NOT_FOUND = "integration.not_found";
const missing = "0192f1c2-7c1e-7a3b-9f00-000000000000";

function expectProblem(res: Res, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(String(res.headers["content-type"])).toMatch(PROBLEM_JSON);
  expect(res.body.code).toBe(code);
}

/** What the attacker must not be able to tell a foreign id from: the answer for an unknown id. */
async function expectSameAsUnknown(res: Res, unknown: Res) {
  expect(res.status).toBe(unknown.status);
  expect(res.body).toEqual(unknown.body);
}

interface Attack {
  label: string;
  run: (attacker: FixtureUser, victim: FixtureUser) => Promise<void>;
}

interface Route {
  /** `METHOD /v1/path` with `:id` for the integration id, as Nest registers it. */
  route: string;
  attacks: Attack[];
  /** The owner makes the same call and it works. */
  control: (owner: FixtureUser) => Promise<void>;
}

const ROUTES: Route[] = [
  {
    route: "GET /v1/me",
    attacks: [
      {
        label: "naming the victim in query and headers",
        run: async (attacker, victim) => {
          const res = await cookieGet(attacker, `/v1/me?userId=${victim.userId}`)
            .set("X-User-Id", victim.userId)
            .set("X-Integration-Id", victim.integrationId);
          expect(res.status).toBe(200);
          expect(res.body.id).toBe(attacker.userId);
          expect(JSON.stringify(res.body)).not.toContain(victim.userId);
        },
      },
    ],
    control: async (owner) => {
      const res = await cookieGet(owner, "/v1/me");
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(owner.userId);
    },
  },
  {
    route: "POST /v1/integrations",
    attacks: [
      {
        label: "naming the victim as owner in the body",
        run: async (attacker, victim) => {
          const res = await cookiePost(attacker, "/v1/integrations", {
            kind: "http",
            name: "stolen",
            userId: victim.userId,
          });
          expectProblem(res, 400, "request.invalid");
          expect(JSON.stringify(res.body)).not.toContain(victim.userId);
        },
      },
      {
        label: "naming the victim in query and headers",
        run: async (attacker, victim) => {
          const res = await cookiePost(attacker, `/v1/integrations?userId=${victim.userId}`, {
            kind: "http",
            name: "own anyway",
          }).set("X-User-Id", victim.userId);
          expect(res.status).toBe(201);
          const created = createIntegrationResponseSchema.parse(res.body);
          const { rows } = await h.testDb.pool.query(
            "select user_id from integrations where id = $1",
            [created.integration.id],
          );
          expect(rows).toEqual([{ user_id: attacker.userId }]);
        },
      },
    ],
    control: async (owner) => {
      expect((await createViaRoute(h.app, owner, "control")).key).toMatch(/^pa_ing_/);
    },
  },
  {
    route: "GET /v1/integrations",
    attacks: [
      {
        label: "listing while the victim has integrations",
        run: async (attacker, victim) => {
          const res = await cookieGet(attacker, `/v1/integrations?userId=${victim.userId}`);
          expect(res.status).toBe(200);
          const list = integrationListResponseSchema.parse(res.body).integrations;
          expect(list.length).toBeGreaterThan(0);
          expect(list.map((i) => i.id)).not.toContain(victim.integrationId);
          const text = JSON.stringify(res.body);
          for (const secret of [victim.integrationId, victim.ingestKey, victim.ingestKeyId]) {
            expect(text).not.toContain(secret);
          }
        },
      },
    ],
    control: async (owner) => {
      const res = await cookieGet(owner, "/v1/integrations");
      expect(res.status).toBe(200);
      expect(integrationListResponseSchema.parse(res.body).integrations.map((i) => i.id)).toContain(
        owner.integrationId,
      );
    },
  },
  {
    route: "GET /v1/integrations/:id",
    attacks: [
      {
        label: "reading the victim's integration",
        run: async (attacker, victim) => {
          const res = await cookieGet(attacker, `/v1/integrations/${victim.integrationId}`);
          expectProblem(res, 404, NOT_FOUND);
          await expectSameAsUnknown(res, await cookieGet(attacker, `/v1/integrations/${missing}`));
        },
      },
    ],
    control: async (owner) => {
      const res = await cookieGet(owner, `/v1/integrations/${owner.integrationId}`);
      expect(res.status).toBe(200);
      expect(res.body.integration.id).toBe(owner.integrationId);
    },
  },
  {
    route: "PATCH /v1/integrations/:id",
    attacks: [
      {
        label: "renaming the victim's integration",
        run: async (attacker, victim) => {
          const res = await cookiePatch(attacker, `/v1/integrations/${victim.integrationId}`, {
            name: "hijacked",
          });
          expectProblem(res, 404, NOT_FOUND);
          await expectSameAsUnknown(
            res,
            await cookiePatch(attacker, `/v1/integrations/${missing}`, { name: "hijacked" }),
          );
        },
      },
      {
        label: "renaming it while naming the owner in the body",
        run: async (attacker, victim) => {
          const res = await cookiePatch(attacker, `/v1/integrations/${victim.integrationId}`, {
            name: "hijacked",
            userId: victim.userId,
          });
          expectProblem(res, 400, "request.invalid");
        },
      },
    ],
    control: async (owner) => {
      const res = await cookiePatch(owner, `/v1/integrations/${owner.integrationId}`, {
        name: "control rename",
      });
      expect(res.status).toBe(200);
      expect(res.body.integration.name).toBe("control rename");
    },
  },
  {
    route: "POST /v1/integrations/:id/revoke",
    attacks: [
      {
        label: "revoking the victim's integration",
        run: async (attacker, victim) => {
          const res = await cookiePost(attacker, `/v1/integrations/${victim.integrationId}/revoke`);
          expectProblem(res, 404, NOT_FOUND);
          await expectSameAsUnknown(
            res,
            await cookiePost(attacker, `/v1/integrations/${missing}/revoke`),
          );
        },
      },
    ],
    control: async (owner) => {
      // A throwaway integration, so the fixture's own stays usable for the rest of the table.
      const spare = await createViaRoute(h.app, owner, "revoke control");
      const res = await cookiePost(owner, `/v1/integrations/${spare.integrationId}/revoke`);
      expect(res.status).toBe(200);
      expect(res.body.integration.status).toBe("revoked");
    },
  },
  {
    route: "POST /v1/ingest/events",
    attacks: [
      {
        label: "naming the victim's integration and user in the body",
        run: async (attacker, victim) => {
          const res = await keyPost(attacker, INGEST_PATH, {
            events: [pageVisit()],
            integrationId: victim.integrationId,
            userId: victim.userId,
          });
          expectProblem(res, 400, "ingest.batch_invalid");
          expect(JSON.stringify(res.body)).not.toContain(victim.integrationId);
        },
      },
      {
        label: "naming the victim in query and headers, and reusing the victim's event id",
        run: async (attacker, victim) => {
          const [stolen] = await eventRows(h.testDb.pool, victim.userId);
          if (!stolen) throw new Error("the victim has a stored event to collide with");
          const event = pageVisit({ id: stolen.client_event_id });
          const res = await keyPost(
            attacker,
            INGEST_PATH,
            { events: [event] },
            `?userId=${victim.userId}&integrationId=${victim.integrationId}`,
          )
            .set("X-User-Id", victim.userId)
            .set("X-Integration-Id", victim.integrationId);
          // Not a duplicate: dedupe never crosses tenants, so the answer says nothing about them.
          expect(expectResults(res).map((r) => r.status)).toEqual(["accepted"]);
          const mine = await eventRows(h.testDb.pool, attacker.userId);
          // The seeded event plus this one, both under the attacker's own integration.
          expect(mine).toHaveLength(2);
          expect(mine.every((r) => r.integration_id === attacker.integrationId)).toBe(true);
        },
      },
    ],
    control: async (owner) => {
      expectResults(await postEvents(h.app, owner.ingestKey, [pageVisit()]));
    },
  },
  {
    route: "POST /v1/ingest/heartbeat",
    attacks: [
      {
        label: "naming the victim's integration in the body",
        run: async (attacker, victim) => {
          const res = await postHeartbeat(h.app, attacker.ingestKey, {
            ...heartbeatBody,
            integrationId: victim.integrationId,
          });
          expectProblem(res, 400, "request.invalid");
        },
      },
      {
        label: "naming the victim in query and headers",
        run: async (attacker, victim) => {
          const res = await keyPost(
            attacker,
            HEARTBEAT_PATH,
            heartbeatBody,
            `?userId=${victim.userId}&integrationId=${victim.integrationId}`,
          ).set("X-Integration-Id", victim.integrationId);
          expect(res.status).toBe(204);
          const { rows } = await h.testDb.pool.query(
            "select id from integrations where last_heartbeat is not null and user_id = $1",
            [attacker.userId],
          );
          expect(rows).toEqual([{ id: attacker.integrationId }]);
        },
      },
    ],
    control: async (owner) => {
      expect((await postHeartbeat(h.app, owner.ingestKey, heartbeatBody)).status).toBe(204);
    },
  },
];

/** Both users start with one stored event and a heartbeat, so "unchanged" is not trivially empty. */
async function seedActivity() {
  for (const user of [h.a, h.b]) {
    expectResults(await postEvents(h.app, user.ingestKey, [pageVisit()]));
    expect((await postHeartbeat(h.app, user.ingestKey, heartbeatBody)).status).toBe(204);
  }
}

const directions = (): Array<[string, FixtureUser, FixtureUser]> => [
  ["A attacks B", h.a, h.b],
  ["B attacks A", h.b, h.a],
];

describe.each(ROUTES)("$route", (row) => {
  for (const attackIndex of row.attacks.keys()) {
    for (const direction of [0, 1]) {
      const attack = row.attacks[attackIndex] as Attack;
      it(`${direction === 0 ? "A attacks B" : "B attacks A"}: ${attack.label}`, async () => {
        await seedActivity();
        const [, attacker, victim] = directions()[direction] as [string, FixtureUser, FixtureUser];
        const victimBefore = await tenantState(h.testDb.pool, victim.userId);

        await attack.run(attacker, victim);

        expect(await tenantState(h.testDb.pool, victim.userId)).toEqual(victimBefore);
        // The victim's credentials still work, and the owner can make the same call.
        expectResults(await postEvents(h.app, victim.ingestKey, [pageVisit()]));
        await row.control(attacker);
      });
    }
  }
});

describe("the table covers every M1 route, and each refuses a missing or wrong-kind credential", () => {
  /** `METHOD /v1/...` for every controller route Nest registered under /v1. */
  function registeredRoutes(): string[] {
    const found: string[] = [];
    for (const module of h.app.get(ModulesContainer).values()) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype;
        if (!controller) continue;
        const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? "");
        for (const name of Object.getOwnPropertyNames(controller.prototype)) {
          const handler = (controller.prototype as Record<string, unknown>)[name];
          if (typeof handler !== "function") continue;
          const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
          if (method === undefined) continue;
          const sub = String(Reflect.getMetadata(PATH_METADATA, handler) ?? "");
          const path = `/${[base, sub].filter(Boolean).join("/")}`
            .replaceAll(/\/+/g, "/")
            .replace(/(.)\/$/, "$1");
          if (path.startsWith("/v1/")) found.push(`${RequestMethod[method]} ${path}`);
        }
      }
    }
    return found.sort();
  }

  it("lists exactly the routes the application registers under /v1", () => {
    expect(ROUTES.map((r) => r.route).sort()).toEqual(registeredRoutes());
  });

  const sessionRoutes = ROUTES.filter((r) => !r.route.includes("/v1/ingest/"));
  const ingestRoutes = ROUTES.filter((r) => r.route.includes("/v1/ingest/"));

  function call(route: string) {
    const [method, path] = route.split(" ") as [string, string];
    const url = path.replace(":id", h.a.integrationId);
    const agent = http();
    const req =
      method === "GET" ? agent.get(url) : method === "PATCH" ? agent.patch(url) : agent.post(url);
    return req;
  }
  const body = (route: string): object => {
    if (route.includes("/events")) return { events: [pageVisit()] };
    if (route.includes("/heartbeat")) return heartbeatBody;
    if (route.startsWith("PATCH")) return { name: "x" };
    if (route === "POST /v1/integrations") return { kind: "http", name: "x" };
    return {};
  };

  it.each(sessionRoutes.map((r) => r.route))(
    "%s: 401 auth.unauthenticated with no credential, an ingest key, a read key or a session token as bearer",
    async (route) => {
      const bearers = [undefined, h.a.ingestKey, generateApiKey("read").plaintext, randomUUID()];
      for (const bearer of bearers) {
        let req = call(route);
        if (bearer) req = req.set("Authorization", `Bearer ${bearer}`);
        expectProblem(await req.send(body(route)), 401, "auth.unauthenticated");
      }
    },
  );

  it.each(ingestRoutes.map((r) => r.route))(
    "%s: 401 auth.invalid_key with no key, a session cookie, a read key or a non-key bearer",
    async (route) => {
      const attempts: Array<(req: ReturnType<typeof call>) => ReturnType<typeof call>> = [
        (req) => req,
        (req) => req.set("Cookie", h.a.cookie),
        (req) => req.set("Authorization", `Bearer ${generateApiKey("read").plaintext}`),
        (req) => req.set("Authorization", `Bearer ${randomUUID()}`),
        (req) => req.set("Cookie", h.a.cookie).set("Authorization", "Bearer pa_ing_"),
      ];
      for (const attempt of attempts) {
        expectProblem(await attempt(call(route)).send(body(route)), 401, "auth.invalid_key");
      }
      expect(await eventRows(h.testDb.pool)).toEqual([]);
    },
  );
});
