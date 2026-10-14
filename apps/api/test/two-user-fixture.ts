/**
 * M1-03 two-user fixture. Every later milestone's cross-tenant tests reuse it.
 *
 * Contract (pinned by src/modules/keys/two-user-fixture.int.spec.ts):
 *  - `buildFixtureApp` builds the real application against the Testcontainers database, like
 *    `buildAuthTestApp` (ALLOW_SIGNUP=true, `bodyParser: false`, APP_CONFIG overridden), but also
 *    imports `KeysModule` and `AuthModule`, registers `AuthProbeController`, and overrides the
 *    `CLOCK` provider with `options.clock` when given.
 *  - `seedTwoUsers` first empties every table (like `resetAuthTables`), then creates users "a" and
 *    "b". Each gets: a real Better Auth account and session cookie (sign-up + sign-in over HTTP),
 *    one `http` integration named "fixture-a" / "fixture-b" with default_policy 'deny', and its
 *    one ingest key, both created through `IntegrationsService.create` (M1-04), so only the key's
 *    hash is stored and the fixture exercises the same path as `POST /v1/integrations`.
 */
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { APP_CONFIG } from "../src/config/config.module";
import { AuthModule } from "../src/modules/auth/auth.module";
import { IntegrationsService } from "../src/modules/integrations/integrations.service";
import { KeysModule } from "../src/modules/keys/keys.module";
import { CLOCK, type Clock } from "../src/platform/clock/clock";
import {
  authTestConfig,
  type Credentials,
  getMe,
  meUser,
  newCredentials,
  resetAuthTables,
  sessionCookie,
  signIn,
  signUp,
} from "./auth.helpers";
import { AuthProbeController } from "./auth-probe.controller";
import type { TestDatabase } from "./postgres";

export interface FixtureUser {
  userId: string;
  credentials: Credentials;
  /** `name=value`, ready for a `Cookie` header: a valid dashboard session for this user. */
  cookie: string;
  integrationId: string;
  /** Plaintext `pa_ing_...` key for `integrationId` (exists only in memory, never in the DB). */
  ingestKey: string;
  ingestKeyId: string;
}

export interface FixtureAppOptions {
  clock?: Clock;
}

export async function buildFixtureApp(
  testDb: TestDatabase,
  options: FixtureAppOptions = {},
): Promise<INestApplication> {
  let builder = Test.createTestingModule({
    imports: [AppModule, AuthModule, KeysModule],
    controllers: [AuthProbeController],
  })
    .overrideProvider(APP_CONFIG)
    .useValue(authTestConfig(testDb, { allowSignup: true }));
  if (options.clock) builder = builder.overrideProvider(CLOCK).useValue(options.clock);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ bodyParser: false });
  await app.init();
  return app;
}

export async function seedTwoUsers(
  app: INestApplication,
  testDb: TestDatabase,
): Promise<{ a: FixtureUser; b: FixtureUser }> {
  await resetAuthTables(testDb.pool);
  const a = await seedUser(app, "a");
  const b = await seedUser(app, "b");
  return { a, b };
}

/** One user, end to end through the real sign-up and the integrations service. */
async function seedUser(app: INestApplication, label: "a" | "b"): Promise<FixtureUser> {
  const credentials = newCredentials(`fixture-${label}`);
  const up = await signUp(app, credentials);
  if (up.status !== 200) throw new Error(`fixture: sign-up for ${label} failed (${up.status})`);
  const login = await signIn(app, credentials);
  const cookie = sessionCookie(login)?.pair;
  if (login.status !== 200 || !cookie) {
    throw new Error(`fixture: sign-in for ${label} failed (${login.status})`);
  }
  const me = await getMe(app, cookie);
  const userId = meUser(me.body).id;
  if (me.status !== 200 || !userId) throw new Error(`fixture: /v1/me for ${label} failed`);

  const { integration, ingestKey } = await app
    .get(IntegrationsService)
    .create(userId, { kind: "http", name: `fixture-${label}` });
  return {
    userId,
    credentials,
    cookie,
    integrationId: integration.id,
    ingestKey: ingestKey.key,
    ingestKeyId: ingestKey.id,
  };
}
