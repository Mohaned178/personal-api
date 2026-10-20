/**
 * The larger body limit is keyed on INGEST_EVENTS_PATH, so the constant must be the route the
 * controller actually serves. If they drifted, the real route would silently fall back to 100 KB
 * (or another path would get 256 KB).
 */
import { RequestMethod } from "@nestjs/common";
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { IngestKeyGuard } from "../keys/ingest-key.guard";
import { INGEST_EVENTS_PATH, IngestController } from "./ingest.controller";
import { IngestRateLimitGuard } from "./ingest-rate-limit.guard";

const handler = IngestController.prototype.events;

describe("IngestController routing", () => {
  it("serves POST on exactly INGEST_EVENTS_PATH", () => {
    const prefix = Reflect.getMetadata(PATH_METADATA, IngestController) as string;
    const route = Reflect.getMetadata(PATH_METADATA, handler) as string;
    expect(`/${prefix}/${route}`).toBe(INGEST_EVENTS_PATH);
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
  });

  it("serves the rules for the extension on GET /v1/ingest/config", () => {
    const config = IngestController.prototype.config;
    const prefix = Reflect.getMetadata(PATH_METADATA, IngestController) as string;
    expect(`/${prefix}/${Reflect.getMetadata(PATH_METADATA, config) as string}`).toBe(
      "/v1/ingest/config",
    );
    expect(Reflect.getMetadata(METHOD_METADATA, config)).toBe(RequestMethod.GET);
  });

  it("answers 200, not 201", () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
  });

  it("is guarded by the key, then the per-key limit, for the whole controller", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, IngestController)).toEqual([
      IngestKeyGuard,
      IngestRateLimitGuard,
    ]);
  });
});
