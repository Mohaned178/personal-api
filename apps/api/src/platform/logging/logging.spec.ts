import { Body, Controller, type INestApplication, Post } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { LoggerModule, PinoLogger } from "nestjs-pino";
import pino from "pino";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { buildPinoHttpOptions, REDACT_CENSOR, REDACT_PATHS } from "./logging";

const SECRETS = [
  "Bearer pa_read_SECRETKEY",
  "pa_ing_SECRETKEY",
  "session=SECRETCOOKIE",
  "hunter2",
  "person@example.com",
  "https://private.example.org/diary?q=1",
  "private.example.org",
  "SECRETBODYVALUE",
  "SECRETQUERYVALUE",
  "SECRETTOKEN",
];

@Controller()
class EchoController {
  constructor(private readonly logger: PinoLogger) {}

  @Post("echo")
  echo(@Body() body: unknown) {
    // Simulates careless logging; the redaction list is the safety net.
    this.logger.info(
      {
        password: "hunter2",
        token: "SECRETTOKEN",
        email: "person@example.com",
        nested: { url: "https://private.example.org/diary?q=1", domain: "private.example.org" },
        deeper: { a: { b: { token: "SECRETTOKEN" } } },
        headers: { authorization: "Bearer pa_read_SECRETKEY", "x-api-key": "pa_ing_SECRETKEY" },
        payload: body,
      },
      "handled",
    );
    return { ok: true };
  }
}

let app: INestApplication;
const lines: string[] = [];

afterEach(async () => {
  await app.close();
  lines.length = 0;
});

describe("log redaction", () => {
  it("never writes secrets, URLs, bodies or auth headers to log output", async () => {
    const stream = { write: (line: string) => void lines.push(line) };
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: { ...buildPinoHttpOptions("info"), stream } })],
      controllers: [EchoController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer())
      .post("/echo?q=SECRETQUERYVALUE")
      .set("Authorization", "Bearer pa_read_SECRETKEY")
      .set("X-Api-Key", "pa_ing_SECRETKEY")
      .set("Cookie", "session=SECRETCOOKIE")
      .send({ note: "SECRETBODYVALUE", email: "person@example.com" })
      .expect(201);

    const output = lines.join("\n");
    expect(output).toContain("handled"); // we really captured the log line
    expect(output).toContain("[Redacted]");
    for (const secret of SECRETS) {
      expect(output, `leaked: ${secret}`).not.toContain(secret);
    }
    // The automatic request log keeps only method, status and timing.
    expect(output).not.toContain("/echo");
  });
});

/** Logs one object through pino configured with the production redaction list. */
function logThroughRedaction(object: Record<string, unknown>): string {
  const out: string[] = [];
  const logger = pino(
    { level: "info", redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR } },
    { write: (line: string) => void out.push(line) },
  );
  logger.info(object, "msg");
  return out.join("\n");
}

/** Wraps `leaf` in `parents` neutral objects, so the leaf's key sits `parents + 1` levels deep. */
function nest(parents: number, leaf: Record<string, unknown>): Record<string, unknown> {
  const names = ["lvlA", "lvlB", "lvlC", "lvlD", "lvlE"];
  let value: Record<string, unknown> = leaf;
  for (let i = parents - 1; i >= 0; i--) value = { [names[i] as string]: value };
  return value;
}

const NEW_SENSITIVE_KEYS = [
  "data",
  "path",
  "href",
  "referer",
  "referrer",
  "key",
  "apiKey",
  "ingestKey",
  "readKey",
  "keyHash",
  "hash",
  "pairingCode",
];

describe("log redaction of envelope fields, keys and hashes", () => {
  it.each(NEW_SENSITIVE_KEYS)("censors `%s` at the top level of a logged object", (key) => {
    const output = logThroughRedaction({ [key]: "LEAKME-value-123" });
    expect(output).toContain(REDACT_CENSOR);
    expect(output).not.toContain("LEAKME-value-123");
  });

  const depths = [1, 2, 3, 4, 5];
  const cases = NEW_SENSITIVE_KEYS.flatMap((key) => depths.map((depth) => [key, depth] as const));
  it.each(cases)("censors `%s` when it sits %i level(s) deep", (key, depth) => {
    const output = logThroughRedaction(nest(depth - 1, { [key]: "LEAKME-value-123" }));
    expect(output).not.toContain("LEAKME-value-123");
  });

  it("censors a nested envelope-shaped object: { event: { data: { domain, path } } }", () => {
    const output = logThroughRedaction({
      event: {
        type: "page_visit",
        data: { domain: "private.example.org", path: "/diary/2026" },
      },
    });
    expect(output).not.toContain("private.example.org");
    expect(output).not.toContain("/diary/2026");
  });

  it("censors envelope fields even when the parent object is not itself redacted (data copied out)", () => {
    const output = logThroughRedaction({
      event: {
        type: "page_visit",
        payload2: { domain: "private.example.org", path: "/diary/2026" },
      },
    });
    expect(output).not.toContain("private.example.org");
    expect(output).not.toContain("/diary/2026");
  });

  it("censors envelopes inside an array of events up to five levels deep", () => {
    const output = logThroughRedaction({
      batch: {
        events: [
          { event: { data: { domain: "private.example.org", path: "/diary/2026" } } },
          { event: { data: { domain: "other.example.net", path: "/inbox" } } },
        ],
      },
    });
    for (const secret of ["private.example.org", "/diary/2026", "other.example.net", "/inbox"]) {
      expect(output, `leaked: ${secret}`).not.toContain(secret);
    }
  });

  it("censors request-metadata style fields: href, referer, referrer", () => {
    const output = logThroughRedaction({
      page: { href: "https://private.example.org/a", referrer: "https://r1.example.org/" },
      headers2: { referer: "https://r2.example.org/" },
    });
    for (const secret of ["private.example.org", "r1.example.org", "r2.example.org"]) {
      expect(output, `leaked: ${secret}`).not.toContain(secret);
    }
  });

  it("censors API keys, key hashes and pairing codes wherever they are logged", () => {
    const output = logThroughRedaction({
      apiKey: "pa_read_LEAK1",
      created: { ingestKey: "pa_ing_LEAK2", readKey: "pa_read_LEAK3", keyHash: "deadbeefLEAK4" },
      row: { integration: { hash: "cafebabeLEAK5", pairingCode: "PAIR-LEAK6", key: "LEAK7" } },
    });
    for (let i = 1; i <= 7; i++) {
      expect(output, `leaked LEAK${i}`).not.toContain(`LEAK${i}`);
    }
  });

  it("keeps error `code` fields visible, at the top level and nested", () => {
    const output = logThroughRedaction({
      code: "ingest.payload_invalid",
      error: { code: "auth.signup_disabled", status: 403 },
      deeper: { a: { b: { code: "rate.limited" } } },
    });
    expect(output).toContain("ingest.payload_invalid");
    expect(output).toContain("auth.signup_disabled");
    expect(output).toContain("rate.limited");
  });

  it("keeps an error code visible next to redacted sensitive fields", () => {
    const output = logThroughRedaction({
      event: { code: "ingest.payload_invalid", data: { domain: "private.example.org" } },
    });
    expect(output).toContain("ingest.payload_invalid");
    expect(output).not.toContain("private.example.org");
  });
});
