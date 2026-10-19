import { describe, expect, it } from "vitest";
import { createExportRequestSchema, exportManifestSchema } from "./exports.js";

describe("exports contract", () => {
  it("accepts no filter and an empty filter, refuses unknown keys and a user id", () => {
    expect(createExportRequestSchema.safeParse({}).success).toBe(true);
    expect(createExportRequestSchema.safeParse({ filter: {} }).success).toBe(true);
    expect(createExportRequestSchema.safeParse({ filter: { domain: "example.com" } }).success).toBe(
      true,
    );
    expect(createExportRequestSchema.safeParse({ filter: { userId: "x" } }).success).toBe(false);
    expect(createExportRequestSchema.safeParse({ userId: "x" }).success).toBe(false);
  });

  it("validates a manifest strictly", () => {
    const manifest = {
      format: "personal-api-export",
      formatVersion: 1,
      exportId: "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b",
      generatedAt: "2026-10-14T12:00:00.000Z",
      filter: {},
      eventCount: 0,
      file: { name: "events.ndjson.gz", sha256: "a".repeat(64), bytes: 20 },
    };
    expect(exportManifestSchema.safeParse(manifest).success).toBe(true);
    expect(exportManifestSchema.safeParse({ ...manifest, extra: 1 }).success).toBe(false);
    expect(
      exportManifestSchema.safeParse({ ...manifest, file: { ...manifest.file, sha256: "zz" } })
        .success,
    ).toBe(false);
  });
});
