import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { cleanupOpenApiDoc } from "nestjs-zod";

/**
 * Where the OpenAPI UI lives. The JSON and YAML documents sit under the same prefix so the
 * dashboard's SPA fallback (web-static.ts) can recognise them as API paths.
 */
export const OPENAPI_PATH = "docs";

/**
 * Serves the OpenAPI document and its UI at `/docs` (JSON at `/docs/json`, YAML at `/docs/yaml`).
 * Request shapes come from the Zod DTOs through nestjs-zod. Swagger's own routes bypass Nest's
 * guards, pipes and filters, so the document is public; it describes shapes only and holds no data.
 * Call before `listen()`.
 */
export function mountOpenApi(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle("Personal API")
    .setDescription("Self-hosted personal data platform. Field-level details are in docs/api.md.")
    .setVersion("1")
    .build();
  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));
  SwaggerModule.setup(OPENAPI_PATH, app, document, {
    jsonDocumentUrl: `${OPENAPI_PATH}/json`,
    yamlDocumentUrl: `${OPENAPI_PATH}/yaml`,
  });
}
