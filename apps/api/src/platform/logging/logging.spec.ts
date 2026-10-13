import { Body, Controller, type INestApplication, Post } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { LoggerModule, PinoLogger } from "nestjs-pino";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { buildPinoHttpOptions } from "./logging";

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
