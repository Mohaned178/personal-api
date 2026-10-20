import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { RuleTrace } from "@personal-api/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const API_DIR = join(REPO_ROOT, "apps/api");
const API_ENTRY = join(API_DIR, "dist/main.js");
const WORKER_ENTRY = join(API_DIR, "dist/worker.js");
const DRIZZLE_KIT = join(API_DIR, "node_modules/drizzle-kit/bin.cjs");

// =============================================================================================
// M2-08 e2e stack: a REAL Postgres, the REAL built API (`apps/api/dist/main.js`, started as a
// child process like `pnpm --filter api start`) and helpers that do what the dashboard does
// (sign up, create a browser-extension integration, issue a pairing code) over HTTP.
//
// Database: `E2E_DATABASE_URL` if set (must not use port 5432), otherwise a Testcontainers
// Postgres of the image pinned in docker-compose.yml. Docker is required in the second case; CI
// has it. Migrations are applied with the same drizzle-kit command as `pnpm db:migrate`.
//
// Requires `pnpm --filter @personal-api/api build` first (the e2e scripts do that).
// =============================================================================================

export interface StoredEvent {
  id: string;
  user_id: string;
  integration_id: string;
  client_event_id: string;
  type: string;
  data: Record<string, unknown>;
  /** Why the server kept the event: the rule-set version and the rules that matched (M4-05). */
  trace: RuleTrace | null;
  occurred_at: Date;
}

/** A rule document as the dashboard saves it (rule-format.md); the server sets `id` and owner. */
export type RuleDocument = Record<string, unknown>;

/** The user's rules, changed over HTTP with the user's session, exactly as the dashboard does. */
export interface AccountRules {
  /** Saves a new rule. Returns its id and the rule-set version after the change. */
  create(rule: RuleDocument): Promise<{ id: string; version: number }>;
  /** Replaces a saved rule with a whole new definition. Returns the new rule-set version. */
  replace(id: string, rule: RuleDocument): Promise<{ version: number }>;
}

/** One call with the user's session cookie, as the dashboard makes it (JSON in, raw Response out). */
export type SessionRequest = (method: string, path: string, body?: unknown) => Promise<Response>;

export interface PairedAccount {
  userId: string;
  /** The sign-in the account was made with, for the routes that ask for the password again. */
  email: string;
  password: string;
  /** The user's session over HTTP: the routes the dashboard calls with its cookie. */
  request: SessionRequest;
  integrationId: string;
  /** Plaintext pairing code exactly as the dashboard shows it (10-minute, single use). */
  pairingCode: string;
  rules: AccountRules;
}

export interface E2eStack {
  /** Origin of the API itself. The extension is paired through a proxy origin instead. */
  apiOrigin: string;
  /** Direct database access for assertions. Read-only by convention. */
  pool: Pool;
  /** Where the API and the worker keep export files (`EXPORT_DIR`). */
  exportDir: string;
  /**
   * Starts the pg-boss worker (`dist/worker.js`) next to the API, with the same database and export
   * directory. Needed by the routes that answer 202 and finish as a job (exports). Idempotent; the
   * stack stops it.
   */
  startWorker(): Promise<void>;
  /**
   * A fresh user (own session) with a fresh browser-extension integration and a fresh code. The
   * user gets one rule that allows page events of `allowedDomains` (default `127.0.0.1`, the
   * fixture site), which the extension fetches when it pairs; everything else is denied by default.
   * With an empty `allowedDomains` the user has no rule at all. `rules` changes the rules later.
   */
  createPairableAccount(label?: string, allowedDomains?: string[]): Promise<PairedAccount>;
  /** Every stored event of an integration, oldest first. */
  eventsOf(integrationId: string): Promise<StoredEvent[]>;
  /** Sum of `ingestion_log.duplicate` for an integration (resent events the server discarded). */
  duplicateCountOf(integrationId: string): Promise<number>;
  /** `pairing_codes.used_at is not null` for the integration's most recent code. */
  pairingCodeUsed(integrationId: string): Promise<boolean>;
  stop(): Promise<void>;
}

/** The one rule `createPairableAccount` saves: allow page events of these domains. */
export const allowDomainsRule = (domains: string[]): RuleDocument => ({
  name: "e2e: allow the fixture site",
  enabled: true,
  priority: 100,
  stage: "collect",
  when: { all: [{ field: "data.domain", op: "in", value: domains }] },
  then: [{ action: "allow" }],
});

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolvePort(port));
    });
  });
}

function composePostgresImage(): string {
  const compose = readFileSync(join(REPO_ROOT, "docker-compose.yml"), "utf8");
  const match = /^\s*image:\s*(postgres:\S+)\s*$/m.exec(compose);
  if (!match?.[1]) throw new Error("no postgres image found in docker-compose.yml");
  return match[1];
}

function assertNotPersonalServer(url: string): void {
  const parsed = new URL(url);
  // The user's own Postgres lives on 5432 (or the default, when no port is given). Never touch it.
  if ((parsed.port || "5432") === "5432") {
    throw new Error("E2E_DATABASE_URL must use an explicit port other than 5432");
  }
}

export async function startStack(): Promise<E2eStack> {
  let container: StartedPostgreSqlContainer | undefined;
  let databaseUrl = process.env.E2E_DATABASE_URL;
  if (databaseUrl) {
    assertNotPersonalServer(databaseUrl);
  } else {
    container = await new PostgreSqlContainer(composePostgresImage()).start();
    databaseUrl = container.getConnectionUri();
  }

  await execFileAsync(process.execPath, [DRIZZLE_KIT, "migrate"], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  const port = await freePort();
  const apiOrigin = `http://127.0.0.1:${port}`;
  const exportDir = await mkdtemp(join(tmpdir(), "pa-e2e-exports-"));
  const processEnv = {
    ...process.env,
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET: `e2e-secret-${randomUUID()}${randomUUID()}`,
    BETTER_AUTH_URL: apiOrigin,
    ALLOW_SIGNUP: "true",
    LOG_LEVEL: "warn",
    EXPORT_DIR: exportDir,
  };
  let output = "";
  const api: ChildProcess = spawn(process.execPath, [API_ENTRY], {
    cwd: API_DIR,
    env: processEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  api.stdout?.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-4_000);
  });
  api.stderr?.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-4_000);
  });
  let exited = false;
  api.once("exit", () => {
    exited = true;
  });

  const pool = new Pool({ connectionString: databaseUrl, max: 4 });

  let worker: ChildProcess | undefined;
  const stopProcess = async (child: ChildProcess): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((done) => {
      child.once("exit", () => done());
      child.kill();
      setTimeout(done, 5_000).unref();
    });
  };

  const stop = async (): Promise<void> => {
    if (worker) await stopProcess(worker);
    await stopProcess(api);
    await pool.end().catch(() => {});
    await container?.stop().catch(() => {});
    await rm(exportDir, { recursive: true, force: true }).catch(() => {});
  };

  const startWorker = async (): Promise<void> => {
    if (worker) return;
    const child: ChildProcess = spawn(process.execPath, [WORKER_ENTRY], {
      cwd: API_DIR,
      env: processEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let workerOutput = "";
    const keep = (chunk: Buffer) => {
      workerOutput = (workerOutput + chunk.toString("utf8")).slice(-4_000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    worker = child;
    // The worker has no port to probe: give it a moment and fail if it dies on start-up.
    await new Promise((r) => setTimeout(r, 3_000));
    if (child.exitCode !== null) {
      throw new Error(`the worker exited during start-up. Last output:\n${workerOutput}`);
    }
  };

  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (exited) throw new Error(`the API exited during start-up. Last output:\n${output}`);
      const ready = await fetch(`${apiOrigin}/readyz`).then(
        (res) => res.ok,
        () => false,
      );
      if (ready) break;
      if (Date.now() > deadline) {
        throw new Error(`the API was not ready within 60 s. Last output:\n${output}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch (error) {
    await stop();
    throw error;
  }

  // Sign-in and sign-up are rate limited per address (3 per 10 s, M7-03), and every test of a
  // worker comes from 127.0.0.1. A test that signs in quickly (M8-01's browser login) can leave the
  // next test inside the window, so a 429 waits out the window and tries again, as a polite client
  // would. The limit itself stays on.
  const authPost = async (path: string, body: unknown): Promise<Response> => {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${apiOrigin}${path}`, {
        method: "POST",
        // Better Auth checks the Origin of browser-style POSTs against BETTER_AUTH_URL.
        headers: { "content-type": "application/json", origin: apiOrigin },
        body: JSON.stringify(body),
      });
      if (res.status !== 429 || attempt === 4) return res;
      const retryAfter = Number(res.headers.get("x-retry-after") ?? res.headers.get("retry-after"));
      const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 15) : 10;
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 250));
    }
  };

  const createPairableAccount = async (
    label = "e2e",
    allowedDomains: string[] = ["127.0.0.1"],
  ): Promise<PairedAccount> => {
    const credentials = {
      email: `${label}-${randomUUID().replaceAll("-", "").slice(0, 12)}@example.test`,
      password: `Pw-${randomUUID()}`,
      name: `E2E ${label}`,
    };
    const signedUp = await authPost("/api/auth/sign-up/email", credentials);
    if (!signedUp.ok) throw new Error(`e2e: sign-up failed (${signedUp.status})`);
    const signedIn = await authPost("/api/auth/sign-in/email", {
      email: credentials.email,
      password: credentials.password,
    });
    if (!signedIn.ok) throw new Error(`e2e: sign-in failed (${signedIn.status})`);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((line) => line.split(";")[0] ?? "")
      .find((pair) => /session_token=/i.test(pair));
    if (!cookie) throw new Error("e2e: sign-in set no session cookie");

    const session = { "content-type": "application/json", cookie, origin: apiOrigin };
    const request: SessionRequest = (method, path, body) =>
      fetch(`${apiOrigin}${path}`, {
        method,
        headers: session,
        body: body === undefined ? null : JSON.stringify(body),
      });
    const me = (await (await fetch(`${apiOrigin}/v1/me`, { headers: session })).json()) as {
      id?: string;
      user?: { id?: string };
    };
    const userId = me.user?.id ?? me.id;
    if (!userId) throw new Error("e2e: /v1/me returned no user id");

    const created = await fetch(`${apiOrigin}/v1/integrations`, {
      method: "POST",
      headers: session,
      body: JSON.stringify({ kind: "browser-extension", name: "E2E browser" }),
    });
    if (created.status !== 201)
      throw new Error(`e2e: create integration ${created.status} ${await created.text()}`);
    const integrationId = ((await created.json()) as { integration: { id: string } }).integration
      .id;

    const rules: AccountRules = {
      create: async (definition) => {
        const res = await fetch(`${apiOrigin}/v1/rules`, {
          method: "POST",
          headers: session,
          body: JSON.stringify(definition),
        });
        if (res.status !== 201)
          throw new Error(`e2e: create rule ${res.status} ${await res.text()}`);
        const body = (await res.json()) as { rule: { id: string }; version: number };
        return { id: body.rule.id, version: body.version };
      },
      replace: async (id, definition) => {
        const res = await fetch(`${apiOrigin}/v1/rules/${id}`, {
          method: "PUT",
          headers: session,
          body: JSON.stringify(definition),
        });
        if (res.status !== 200)
          throw new Error(`e2e: replace rule ${res.status} ${await res.text()}`);
        return { version: ((await res.json()) as { version: number }).version };
      },
    };

    // The user's rules decide what is collected, in the extension (M4-06: it fetches them when it
    // pairs) and again on the server (M4-05). A new extension denies by default, so allow page
    // events of these domains. Events without a domain (tab_opened without one, sessions) stay
    // denied.
    if (allowedDomains.length > 0) await rules.create(allowDomainsRule(allowedDomains));

    const issued = await fetch(`${apiOrigin}/v1/integrations/${integrationId}/pairing-code`, {
      method: "POST",
      headers: session,
    });
    if (issued.status !== 201)
      throw new Error(
        `e2e: pairing code ${issued.status} ${await issued.text()} for ${integrationId}`,
      );
    const { pairingCode } = (await issued.json()) as { pairingCode: string };
    return {
      userId,
      email: credentials.email,
      password: credentials.password,
      request,
      integrationId,
      pairingCode,
      rules,
    };
  };

  return {
    apiOrigin,
    pool,
    exportDir,
    startWorker,
    createPairableAccount,
    eventsOf: async (integrationId) =>
      (
        await pool.query<StoredEvent>(
          `select id, user_id, integration_id, client_event_id, type, data, trace, occurred_at
             from events where integration_id = $1 order by occurred_at, id`,
          [integrationId],
        )
      ).rows,
    duplicateCountOf: async (integrationId) =>
      Number(
        (
          await pool.query<{ n: string }>(
            "select coalesce(sum(duplicate), 0)::text as n from ingestion_log where integration_id = $1",
            [integrationId],
          )
        ).rows[0]?.n ?? 0,
      ),
    pairingCodeUsed: async (integrationId) =>
      (
        await pool.query<{ used: boolean }>(
          `select (used_at is not null) as used from pairing_codes
            where integration_id = $1 order by created_at desc limit 1`,
          [integrationId],
        )
      ).rows[0]?.used === true,
    stop,
  };
}
