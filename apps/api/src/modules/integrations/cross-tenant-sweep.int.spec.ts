/**
 * M1-07 cross-tenant sweep: every route (`/v1/me`, integrations create/list/get/rename/revoke,
 * ingest events, ingest heartbeat, and from M2-01 the pairing code and `POST /v1/pair`) is attacked by user A against user B and by B against A, in one
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
import {
  createExtension,
  issueCode,
  PAIR_PATH,
  pair,
  requestCode,
} from "../../../test/pairing-helpers";
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
const cookiePut = (u: FixtureUser, path: string, body?: unknown) =>
  http()
    .put(path)
    .set("Cookie", u.cookie)
    .send(body as object);
const cookieRemove = (u: FixtureUser, path: string) => http().delete(path).set("Cookie", u.cookie);
const cookieDelete = (u: FixtureUser, body: unknown) =>
  http()
    .delete("/v1/events")
    .set("Cookie", u.cookie)
    .send(body as object);
async function firstEventId(u: FixtureUser): Promise<string> {
  const { rows } = await h.testDb.pool.query<{ id: string }>(
    "select id from events where user_id = $1 order by id limit 1",
    [u.userId],
  );
  return (rows[0] as { id: string }).id;
}
const keyGet = (u: FixtureUser, path: string, query = "") =>
  http().get(`${path}${query}`).set("Authorization", `Bearer ${u.ingestKey}`);
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

/** The rule every user starts with in the sweep: it allows github.com. */
const ruleBody = {
  name: "Track GitHub",
  enabled: true,
  priority: 10,
  stage: "collect",
  when: { all: [{ field: "data.domain", op: "eq", value: "github.com" }] },
  then: [{ action: "allow" }],
};
const githubVisit = () => pageVisit({ data: { domain: "github.com" } });
const ruleIds = new Map<string, string>();
/** Each user's read key (id and plaintext), set per test. */
const readKeys = new Map<string, { id: string; key: string }>();

/** Each user's extension integration and its pending (unused, unexpired) code, set per test. */
const pending = new Map<string, { integrationId: string; pairingCode: string }>();

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
    route: "POST /v1/integrations/:id/pairing-code",
    attacks: [
      {
        label: "requesting a code for the victim's extension",
        run: async (attacker, victim) => {
          const target = pending.get(victim.userId);
          if (!target) throw new Error("the victim has a pending code");
          const res = await requestCode(h.app, attacker, target.integrationId);
          expectProblem(res, 404, NOT_FOUND);
          await expectSameAsUnknown(res, await requestCode(h.app, attacker, missing));
          // The victim's pending code was neither replaced nor invalidated: the tenant state the
          // loop compares includes their pairing_codes rows.
        },
      },
      {
        label: "naming the victim in query and headers while requesting for their own extension",
        run: async (attacker, victim) => {
          const own = pending.get(attacker.userId);
          if (!own) throw new Error("the attacker has an extension");
          const res = await requestCode(h.app, attacker, own.integrationId)
            .query({ userId: victim.userId, integrationId: victim.integrationId })
            .set("X-User-Id", victim.userId);
          expect(res.status).toBe(201);
          const { rows } = await h.testDb.pool.query(
            "select user_id, integration_id from pairing_codes where integration_id = $1",
            [own.integrationId],
          );
          expect(rows).toEqual([{ user_id: attacker.userId, integration_id: own.integrationId }]);
        },
      },
    ],
    control: async (owner) => {
      const spare = await createExtension(h.app, owner, "pairing control");
      expect((await requestCode(h.app, owner, spare)).status).toBe(201);
    },
  },
  {
    route: "POST /v1/pair",
    attacks: [
      {
        label: "naming the victim's user and integration in the body",
        run: async (attacker, victim) => {
          const own = pending.get(attacker.userId);
          if (!own) throw new Error("the attacker has a pending code");
          const res = await pair(h.app, {
            pairingCode: own.pairingCode,
            userId: victim.userId,
            integrationId: victim.integrationId,
          });
          expectProblem(res, 400, "request.invalid");
          expect(JSON.stringify(res.body)).not.toContain(victim.userId);
          expect(JSON.stringify(res.body)).not.toContain(victim.integrationId);
        },
      },
      {
        label: "guessing a code while naming the victim in query and headers",
        run: async (attacker, victim) => {
          const guess = pending.get(attacker.userId)?.pairingCode.replace(/^.{4}/, "0000");
          const res = await http()
            .post(`${PAIR_PATH}?userId=${victim.userId}&integrationId=${victim.integrationId}`)
            .set("X-User-Id", victim.userId)
            .set("X-Integration-Id", victim.integrationId)
            .send({ pairingCode: guess });
          expectProblem(res, 400, "pairing.code_invalid");
        },
      },
    ],
    control: async (owner) => {
      const spare = await createExtension(h.app, owner, "pair control");
      const { pairingCode } = await issueCode(h.app, owner, spare);
      const res = await pair(h.app, { pairingCode });
      expect(res.status).toBe(200);
      expect(res.body.integration.id).toBe(spare);
    },
  },
  {
    route: "GET /v1/setup/status",
    attacks: [
      {
        label: "naming the victim in query and headers (public route, answers the same for all)",
        run: async (attacker, victim) => {
          const plain = await http().get("/v1/setup/status");
          const res = await http()
            .get(`/v1/setup/status?userId=${victim.userId}`)
            .set("X-User-Id", victim.userId)
            .set("X-Integration-Id", victim.integrationId);
          expect(res.status).toBe(200);
          expect(res.body).toEqual(plain.body);
          expect(Object.keys(res.body).sort()).toEqual(["needsSetup", "signupOpen"]);
          const text = JSON.stringify(res.body);
          for (const id of [victim.userId, victim.integrationId, attacker.userId]) {
            expect(text).not.toContain(id);
          }
        },
      },
    ],
    control: async () => {
      const res = await http().get("/v1/setup/status");
      expect(res.status).toBe(200);
      expect(res.body.needsSetup).toBe(false);
    },
  },
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
  {
    route: "GET /v1/ingest/config",
    attacks: [
      {
        label: "naming the victim in query and headers",
        run: async (attacker, victim) => {
          const res = await keyGet(
            attacker,
            "/v1/ingest/config",
            `?userId=${victim.userId}&integrationId=${victim.integrationId}`,
          ).set("X-User-Id", victim.userId);
          expect(res.status).toBe(200);
          expect(res.body.rules.map((r: { id: string }) => r.id)).toEqual([
            ruleIds.get(attacker.userId),
          ]);
          expect(JSON.stringify(res.body)).not.toContain(ruleIds.get(victim.userId));
        },
      },
      {
        label: "sending the victim's ETag to learn whether their rules are unchanged",
        run: async (attacker, victim) => {
          const victimTag = (await keyGet(victim, "/v1/ingest/config")).headers.etag as string;
          const res = await keyGet(attacker, "/v1/ingest/config").set("If-None-Match", victimTag);
          expect(res.status).toBe(200);
          expect(res.headers.etag).not.toBe(victimTag);
        },
      },
    ],
    control: async (owner) => {
      const res = await keyGet(owner, "/v1/ingest/config");
      expect(res.status).toBe(200);
      expect(res.body.rules).toHaveLength(1);
    },
  },
  {
    route: "GET /v1/events",
    attacks: [
      {
        label: "listing while the victim has events, naming the victim in query and headers",
        run: async (attacker, victim) => {
          const res = await cookieGet(attacker, `/v1/events?source=${victim.integrationId}`).set(
            "X-User-Id",
            victim.userId,
          );
          expect(res.status).toBe(200);
          expect(res.body.events).toEqual([]);
          const all = await cookieGet(attacker, "/v1/events");
          const text = JSON.stringify(all.body);
          for (const secret of [victim.userId, victim.integrationId]) {
            expect(text).not.toContain(secret);
          }
          const named = await cookieGet(attacker, `/v1/events?userId=${victim.userId}`);
          expectProblem(named, 400, "request.invalid");
        },
      },
    ],
    control: async (owner) => {
      const res = await cookieGet(owner, "/v1/events");
      expect(res.status).toBe(200);
      expect(res.body.events.length).toBeGreaterThan(0);
    },
  },
  {
    route: "GET /v1/diagnostics",
    attacks: [
      {
        label:
          "reading diagnostics while the victim has sources, naming the victim in query and headers",
        run: async (attacker, victim) => {
          const res = await cookieGet(attacker, "/v1/diagnostics").set("X-User-Id", victim.userId);
          expect(res.status).toBe(200);
          const text = JSON.stringify(res.body);
          for (const secret of [victim.userId, victim.integrationId]) {
            expect(text).not.toContain(secret);
          }
          const named = await cookieGet(attacker, `/v1/diagnostics?userId=${victim.userId}`);
          expectProblem(named, 400, "request.invalid");
        },
      },
    ],
    control: async (owner) => {
      const res = await cookieGet(owner, "/v1/diagnostics");
      expect(res.status).toBe(200);
      expect(res.body.integrations.map((i: { id: string }) => i.id)).toContain(owner.integrationId);
    },
  },
  {
    route: "GET /v1/events/:id",
    attacks: [
      {
        label: "reading the victim's event",
        run: async (attacker, victim) => {
          const id = await firstEventId(victim);
          const res = await cookieGet(attacker, `/v1/events/${id}`);
          expectProblem(res, 404, "event.not_found");
          await expectSameAsUnknown(res, await cookieGet(attacker, `/v1/events/${missing}`));
        },
      },
    ],
    control: async (owner) => {
      const res = await cookieGet(owner, `/v1/events/${await firstEventId(owner)}`);
      expect(res.status).toBe(200);
      expect(res.body.event.integrationId).toBe(owner.integrationId);
    },
  },
  {
    route: "DELETE /v1/events",
    attacks: [
      {
        label: "deleting the victim's event by id",
        run: async (attacker, victim) => {
          const res = await cookieDelete(attacker, { ids: [await firstEventId(victim)] });
          expect(res.status).toBe(200);
          expect(res.body).toEqual({ deleted: 0 });
          // The victim's rows are compared before and after by the loop.
        },
      },
      {
        label: "naming the victim as owner in the body",
        run: async (attacker, victim) => {
          const res = await cookieDelete(attacker, {
            ids: [await firstEventId(victim)],
            userId: victim.userId,
          });
          expectProblem(res, 400, "request.invalid");
          expect(JSON.stringify(res.body)).not.toContain(victim.userId);
        },
      },
    ],
    control: async (owner) => {
      const res = await cookieDelete(owner, { ids: [await firstEventId(owner)] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deleted: 1 });
    },
  },
  {
    route: "GET /v1/rules",
    attacks: [
      {
        label: "listing while the victim has a rule, naming the victim in query and headers",
        run: async (attacker, victim) => {
          const res = await cookieGet(attacker, `/v1/rules?userId=${victim.userId}`).set(
            "X-User-Id",
            victim.userId,
          );
          expect(res.status).toBe(200);
          expect(res.body.rules.map((r: { id: string }) => r.id)).toEqual([
            ruleIds.get(attacker.userId),
          ]);
          expect(JSON.stringify(res.body)).not.toContain(ruleIds.get(victim.userId));
        },
      },
    ],
    control: async (owner) => {
      const res = await cookieGet(owner, "/v1/rules");
      expect(res.status).toBe(200);
      expect(res.body.rules).toHaveLength(1);
    },
  },
  {
    route: "POST /v1/rules",
    attacks: [
      {
        label: "naming the victim as owner in the body",
        run: async (attacker, victim) => {
          const res = await cookiePost(attacker, "/v1/rules", {
            ...ruleBody,
            userId: victim.userId,
          });
          expectProblem(res, 400, "request.invalid");
          expect(JSON.stringify(res.body)).not.toContain(victim.userId);
        },
      },
      {
        label: "creating a rule while naming the victim in query and headers",
        run: async (attacker, victim) => {
          const res = await cookiePost(attacker, `/v1/rules?userId=${victim.userId}`, ruleBody).set(
            "X-User-Id",
            victim.userId,
          );
          expect(res.status).toBe(201);
          const { rows } = await h.testDb.pool.query("select user_id from rules where id = $1", [
            res.body.rule.id,
          ]);
          expect(rows).toEqual([{ user_id: attacker.userId }]);
        },
      },
    ],
    control: async (owner) => {
      expect((await cookiePost(owner, "/v1/rules", ruleBody)).status).toBe(201);
    },
  },
  {
    route: "POST /v1/rules/test",
    attacks: [
      {
        label: "testing an event the victim's rule would allow",
        run: async (attacker, victim) => {
          // The attacker has the same rule as the victim, so remove theirs first: only then can
          // a result that allows come from the victim's rules.
          expect(
            (await cookieRemove(attacker, `/v1/rules/${ruleIds.get(attacker.userId)}`)).status,
          ).toBe(200);
          const res = await cookiePost(attacker, "/v1/rules/test", {
            event: githubVisit(),
            source: "http",
          });
          expect(res.status).toBe(200);
          expect(res.body).toMatchObject({
            decision: "drop",
            trace: { decidedBy: "default_policy", matched: [] },
          });
          expect(JSON.stringify(res.body)).not.toContain(ruleIds.get(victim.userId));
        },
      },
      {
        label: "replacing the victim's rule id in a dry run",
        run: async (attacker, victim) => {
          const body = (id: string) => ({
            event: githubVisit(),
            source: "http",
            rule: ruleBody,
            replaceRuleId: id,
          });
          const res = await cookiePost(
            attacker,
            "/v1/rules/test",
            body(ruleIds.get(victim.userId) as string),
          );
          expectProblem(res, 404, "rule.not_found");
          await expectSameAsUnknown(
            res,
            await cookiePost(attacker, "/v1/rules/test", body(missing)),
          );
        },
      },
    ],
    control: async (owner) => {
      const res = await cookiePost(owner, "/v1/rules/test", {
        event: githubVisit(),
        source: "http",
      });
      expect(res.status).toBe(200);
      expect(res.body.decision).toBeDefined();
    },
  },
  {
    route: "GET /v1/rules/:id",
    attacks: [
      {
        label: "reading the victim's rule",
        run: async (attacker, victim) => {
          const res = await cookieGet(attacker, `/v1/rules/${ruleIds.get(victim.userId)}`);
          expectProblem(res, 404, "rule.not_found");
          await expectSameAsUnknown(res, await cookieGet(attacker, `/v1/rules/${missing}`));
        },
      },
    ],
    control: async (owner) => {
      const res = await cookieGet(owner, `/v1/rules/${ruleIds.get(owner.userId)}`);
      expect(res.status).toBe(200);
      expect(res.body.rule.id).toBe(ruleIds.get(owner.userId));
    },
  },
  {
    route: "PUT /v1/rules/:id",
    attacks: [
      {
        label: "replacing the victim's rule",
        run: async (attacker, victim) => {
          const body = { ...ruleBody, name: "hijacked", then: [{ action: "drop" }] };
          const res = await cookiePut(attacker, `/v1/rules/${ruleIds.get(victim.userId)}`, body);
          expectProblem(res, 404, "rule.not_found");
          await expectSameAsUnknown(res, await cookiePut(attacker, `/v1/rules/${missing}`, body));
        },
      },
    ],
    control: async (owner) => {
      const res = await cookiePut(owner, `/v1/rules/${ruleIds.get(owner.userId)}`, {
        ...ruleBody,
        name: "renamed",
      });
      expect(res.status).toBe(200);
      expect(res.body.rule.name).toBe("renamed");
    },
  },
  {
    route: "DELETE /v1/rules/:id",
    attacks: [
      {
        label: "deleting the victim's rule",
        run: async (attacker, victim) => {
          const res = await cookieRemove(attacker, `/v1/rules/${ruleIds.get(victim.userId)}`);
          expectProblem(res, 404, "rule.not_found");
          await expectSameAsUnknown(res, await cookieRemove(attacker, `/v1/rules/${missing}`));
        },
      },
    ],
    control: async (owner) => {
      expect((await cookieRemove(owner, `/v1/rules/${ruleIds.get(owner.userId)}`)).status).toBe(
        200,
      );
    },
  },
  {
    route: "POST /v1/keys",
    attacks: [
      {
        label: "naming the victim as owner in the body",
        run: async (attacker, victim) => {
          const res = await cookiePost(attacker, "/v1/keys", {
            scopes: ["events:read"],
            userId: victim.userId,
          });
          expectProblem(res, 400, "request.invalid");
          expect(JSON.stringify(res.body)).not.toContain(victim.userId);
        },
      },
      {
        label: "restricting a key to the victim's integration",
        run: async (attacker, victim) => {
          const res = await cookiePost(attacker, "/v1/keys", {
            scopes: ["events:read"],
            restriction: { sources: [victim.integrationId] },
          });
          expectProblem(res, 404, NOT_FOUND);
          await expectSameAsUnknown(
            res,
            await cookiePost(attacker, "/v1/keys", {
              scopes: ["events:read"],
              restriction: { sources: [missing] },
            }),
          );
          expect(JSON.stringify(res.body)).not.toContain(victim.integrationId);
        },
      },
      {
        label: "creating a key while naming the victim in query and headers",
        run: async (attacker, victim) => {
          const res = await cookiePost(attacker, `/v1/keys?userId=${victim.userId}`, {
            scopes: ["events:read"],
          }).set("X-User-Id", victim.userId);
          expect(res.status).toBe(201);
          const { rows } = await h.testDb.pool.query(
            "select user_id, integration_id from api_keys where id = $1",
            [res.body.readKey.id],
          );
          expect(rows).toEqual([{ user_id: attacker.userId, integration_id: null }]);
        },
      },
    ],
    control: async (owner) => {
      const res = await cookiePost(owner, "/v1/keys", {
        scopes: ["events:read"],
        restriction: { sources: [owner.integrationId] },
      });
      expect(res.status).toBe(201);
      expect(res.body.key).toMatch(/^pa_read_/);
    },
  },
  {
    route: "GET /v1/keys",
    attacks: [
      {
        label: "listing while the victim has a read key, naming the victim in query and headers",
        run: async (attacker, victim) => {
          const res = await cookieGet(attacker, `/v1/keys?userId=${victim.userId}`).set(
            "X-User-Id",
            victim.userId,
          );
          expect(res.status).toBe(200);
          // Earlier rows in this run left more keys behind, so compare with the rows themselves.
          const listed = res.body.readKeys.map((k: { id: string }) => k.id);
          const owned = async (user: FixtureUser) =>
            (
              await h.testDb.pool.query<{ id: string }>(
                "select id from api_keys where user_id = $1 and kind = 'read'",
                [user.userId],
              )
            ).rows.map((r) => r.id);
          expect([...listed].sort()).toEqual((await owned(attacker)).sort());
          const victimIds = await owned(victim);
          expect(victimIds.length).toBeGreaterThan(0);
          const text = JSON.stringify(res.body);
          for (const secret of [
            ...victimIds,
            readKeys.get(victim.userId)?.key,
            victim.ingestKeyId,
            victim.ingestKey,
          ]) {
            expect(text).not.toContain(secret);
          }
        },
      },
    ],
    control: async (owner) => {
      const res = await cookieGet(owner, "/v1/keys");
      expect(res.status).toBe(200);
      expect(res.body.readKeys.map((k: { id: string }) => k.id)).toContain(
        readKeys.get(owner.userId)?.id,
      );
    },
  },
  {
    route: "POST /v1/keys/:id/revoke",
    attacks: [
      {
        label: "revoking the victim's read key",
        run: async (attacker, victim) => {
          const id = readKeys.get(victim.userId)?.id as string;
          const res = await cookiePost(attacker, `/v1/keys/${id}/revoke`);
          expectProblem(res, 404, "key.not_found");
          await expectSameAsUnknown(res, await cookiePost(attacker, `/v1/keys/${missing}/revoke`));
          // The victim's key is not revoked: their api_keys rows are compared before and after.
        },
      },
      {
        label: "revoking the victim's ingest key through the read key route",
        run: async (attacker, victim) => {
          const res = await cookiePost(attacker, `/v1/keys/${victim.ingestKeyId}/revoke`);
          expectProblem(res, 404, "key.not_found");
        },
      },
      {
        label: "revoking the attacker's own ingest key by id (not a read key)",
        run: async (attacker) => {
          const res = await cookiePost(attacker, `/v1/keys/${attacker.ingestKeyId}/revoke`);
          expectProblem(res, 404, "key.not_found");
        },
      },
    ],
    control: async (owner) => {
      // A throwaway key, so the seeded one stays usable for the rest of the table.
      const spare = await cookiePost(owner, "/v1/keys", { scopes: ["activity:read"] });
      const res = await cookiePost(owner, `/v1/keys/${spare.body.readKey.id}/revoke`);
      expect(res.status).toBe(200);
      expect(res.body.readKey.revokedAt).not.toBeNull();
    },
  },
];

/**
 * Both users start with one stored event, a heartbeat, a rule, and an extension with a pending
 * pairing code, so "unchanged" is not trivially empty.
 */
async function seedActivity() {
  for (const user of [h.a, h.b]) {
    // `GET /v1/ingest/config` is for browser extensions, so the fixture's integration is one.
    await h.testDb.pool.query("update integrations set kind = 'browser-extension' where id = $1", [
      user.integrationId,
    ]);
    const integrationId = await createExtension(h.app, user, "sweep extension");
    const { pairingCode } = await issueCode(h.app, user, integrationId);
    pending.set(user.userId, { integrationId, pairingCode });
    expectResults(await postEvents(h.app, user.ingestKey, [pageVisit()]));
    expect((await postHeartbeat(h.app, user.ingestKey, heartbeatBody)).status).toBe(204);
    const created = await cookiePost(user, "/v1/rules", ruleBody);
    expect(created.status).toBe(201);
    ruleIds.set(user.userId, created.body.rule.id);
    const readKey = await cookiePost(user, "/v1/keys", { scopes: ["events:read"] });
    expect(readKey.status).toBe(201);
    readKeys.set(user.userId, { id: readKey.body.readKey.id, key: readKey.body.key });
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

  const sessionRoutes = ROUTES.filter(
    (r) =>
      !r.route.includes("/v1/ingest/") &&
      r.route !== "POST /v1/pair" &&
      r.route !== "GET /v1/setup/status" &&
      // Open to a read key too (M5-02); its credential matrix is in events.int.spec.ts.
      r.route !== "GET /v1/events",
  );
  const ingestRoutes = ROUTES.filter((r) => r.route.includes("/v1/ingest/"));

  function call(route: string) {
    const [method, path] = route.split(" ") as [string, string];
    const url = path.replace(":id", h.a.integrationId);
    const agent = http();
    if (method === "GET") return agent.get(url);
    if (method === "PATCH") return agent.patch(url);
    if (method === "PUT") return agent.put(url);
    if (method === "DELETE") return agent.delete(url);
    return agent.post(url);
  }
  const body = (route: string): object => {
    if (route.includes("/events")) return { events: [pageVisit()] };
    if (route.includes("/heartbeat")) return heartbeatBody;
    if (route.startsWith("PATCH")) return { name: "x" };
    if (route === "POST /v1/integrations") return { kind: "http", name: "x" };
    if (route === "POST /v1/pair") return { pairingCode: "x" };
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

  it("GET /v1/events: no credential is 401 auth.unauthenticated; any bearer takes the key path", async () => {
    expectProblem(await call("GET /v1/events"), 401, "auth.unauthenticated");
    for (const bearer of [h.a.ingestKey, generateApiKey("read").plaintext, randomUUID()]) {
      const res = await call("GET /v1/events").set("Authorization", `Bearer ${bearer}`);
      expectProblem(res, 401, "auth.invalid_key");
    }
  });

  it("POST /v1/pair is the one open route: no credential is needed, and none changes the answer", async () => {
    const attempts: Array<(req: ReturnType<typeof call>) => ReturnType<typeof call>> = [
      (req) => req,
      (req) => req.set("Cookie", h.a.cookie),
      (req) => req.set("Authorization", `Bearer ${h.a.ingestKey}`),
      (req) => req.set("Authorization", `Bearer ${generateApiKey("read").plaintext}`),
    ];
    for (const attempt of attempts) {
      expectProblem(
        await attempt(call("POST /v1/pair")).send(body("POST /v1/pair")),
        400,
        "pairing.code_invalid",
      );
    }
  });

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
