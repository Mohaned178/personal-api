import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "../../../test/postgres";
import { APP_CONFIG, ConfigModule } from "../../config/config.module";
import { HealthModule } from "../health/health.module";
import { JobsModule } from "./jobs.module";
import { JobsService } from "./jobs.service";
import { NOOP_QUEUE, PG_BOSS } from "./jobs.tokens";

let testDb: TestDatabase;
let api: INestApplication;
let worker: INestApplicationContext;

beforeAll(async () => {
  testDb = await startTestDatabase();
  const build = (work: boolean) =>
    Test.createTestingModule({
      imports: [ConfigModule, HealthModule, JobsModule.forRoot({ work })],
    })
      .overrideProvider(APP_CONFIG)
      .useValue({ DATABASE_URL: testDb.url })
      .compile();
  api = (await build(false)).createNestApplication();
  await api.init();
  worker = await (await build(true)).init();
}, 120_000);

afterAll(async () => {
  await worker?.close();
  await api?.close();
  await testDb?.stop();
});

describe("jobs (Testcontainers)", () => {
  it("/readyz reports the queue as up", async () => {
    const res = await request(api.getHttpServer()).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.checks.queue).toBe("up");
  });

  it("the API enqueues a no-op job and the worker completes it", async () => {
    const jobId = await api.get(JobsService).enqueue(NOOP_QUEUE, {});
    expect(jobId).toBeTruthy();

    const boss = api.get<PgBoss>(PG_BOSS);
    await expect
      .poll(
        async () => {
          const [job] = await boss.findJobs(NOOP_QUEUE, { id: jobId as string });
          return job?.state;
        },
        { timeout: 30_000, interval: 250 },
      )
      .toBe("completed");
  }, 40_000);
});
