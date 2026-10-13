import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readComposePostgresImage } from "./postgres";

describe("test database helper", () => {
  it("uses the exact image tag pinned in docker-compose.yml", () => {
    const image = readComposePostgresImage();
    expect(image).toMatch(/^postgres:18\.\d+$/);
    const compose = readFileSync(path.resolve(__dirname, "../../../docker-compose.yml"), "utf8");
    expect(compose).toContain(`image: ${image}`);
  });
});
