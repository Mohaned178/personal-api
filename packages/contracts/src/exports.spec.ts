import { describe, expect, it } from "vitest";
import {
  createExportRequestSchema,
  EXPORT_LIMIT_REACHED_CODE,
  EXPORT_MAX_ACTIVE,
  EXPORT_MAX_PER_DAY,
  EXPORTS_CURSOR_INVALID_CODE,
  EXPORTS_LIST_LIMIT,
  exportManifestSchema,
  listExportsQuerySchema,
  listExportsResponseSchema,
} from "./exports.js";

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

describe("exports list query and limits", () => {
  it("accepts a cursor and a limit within bounds, refuses anything else", () => {
    expect(listExportsQuerySchema.safeParse({}).success).toBe(true);
    expect(listExportsQuerySchema.safeParse({ cursor: "abc", limit: "10" }).success).toBe(true);
    expect(listExportsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(
      listExportsQuerySchema.safeParse({ limit: String(EXPORTS_LIST_LIMIT + 1) }).success,
    ).toBe(false);
    expect(listExportsQuerySchema.safeParse({ cursor: "" }).success).toBe(false);
    expect(listExportsQuerySchema.safeParse({ userId: "x" }).success).toBe(false);
  });

  it("returns a nextCursor with the list", () => {
    expect(listExportsResponseSchema.safeParse({ exports: [], nextCursor: null }).success).toBe(
      true,
    );
    expect(listExportsResponseSchema.safeParse({ exports: [] }).success).toBe(false);
  });

  it("pins the per-user caps and the stable codes", () => {
    expect(EXPORT_MAX_ACTIVE).toBe(3);
    expect(EXPORT_MAX_PER_DAY).toBe(10);
    expect(EXPORT_LIMIT_REACHED_CODE).toBe("export.limit_reached");
    expect(EXPORTS_CURSOR_INVALID_CODE).toBe("export.cursor_invalid");
  });
});
