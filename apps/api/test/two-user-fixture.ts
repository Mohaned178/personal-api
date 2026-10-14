/**
 * M1-03 two-user fixture (test-writer STUB: the builder implements the bodies, keeping these
 * signatures; every later milestone's cross-tenant tests reuse it).
 *
 * Contract (pinned by src/modules/keys/two-user-fixture.int.spec.ts):
 *  - `buildFixtureApp` builds the real application against the Testcontainers database, like
 *    `buildAuthTestApp` (ALLOW_SIGNUP=true, `bodyParser: false`, APP_CONFIG overridden), but also
 *    imports `KeysModule` and `AuthModule`, registers `AuthProbeController`, and overrides the
 *    `CLOCK` provider with `options.clock` when given.
 *  - `seedTwoUsers` first empties every table (like `resetAuthTables`), then creates users "a" and
 *    "b". Each gets: a real Better Auth account and session cookie (sign-up + sign-in over HTTP),
 *    one `http` integration named "fixture-a" / "fixture-b" with default_policy 'deny' (created
 *    through `tenantScope(db, userId).insert(integrations, ...)`), and one ingest key for that
 *    integration created through `ApiKeysService.createIngestKey` (so only the hash is stored).
 *    M1-04 may switch the integration step to its IntegrationsService; the shape stays the same.
 */
import type { INestApplication } from "@nestjs/common";
import type { Clock } from "../src/platform/clock/clock";
import type { Credentials } from "./auth.helpers";
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
  _testDb: TestDatabase,
  _options: FixtureAppOptions = {},
): Promise<INestApplication> {
  throw new Error("not implemented: buildFixtureApp");
}

export async function seedTwoUsers(
  _app: INestApplication,
  _testDb: TestDatabase,
): Promise<{ a: FixtureUser; b: FixtureUser }> {
  throw new Error("not implemented: seedTwoUsers");
}
