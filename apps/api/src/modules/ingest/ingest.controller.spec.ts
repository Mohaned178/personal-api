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

const handler = IngestController.prototype.events;

describe("IngestController routing", () => {
  it("serves POST on exactly INGEST_EVENTS_PATH", () => {
    const prefix = Reflect.getMetadata(PATH_METADATA, IngestController) as string;
    const route = Reflect.getMetadata(PATH_METADATA, handler) as string;
    expect(`/${prefix}/${route}`).toBe(INGEST_EVENTS_PATH);
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
  });

  it("answers 200, not 201", () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
  });

  it("is guarded by IngestKeyGuard for the whole controller", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, IngestController)).toEqual([IngestKeyGuard]);
  });
});
