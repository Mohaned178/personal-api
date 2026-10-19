import { createReadStream } from "node:fs";
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import {
  EXPORT_EVENTS_FILE,
  EXPORT_MANIFEST_FILE,
  type ExportResponse,
  type ListExportsResponse,
} from "@personal-api/contracts";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { CreateExportDto } from "./exports.dto";
import { ExportsService } from "./exports.service";

/** Dashboard routes for data exports. The user is the session's, never the body's or the path's. */
@Controller("v1/exports")
@UseGuards(SessionGuard)
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  @Post()
  @HttpCode(202)
  create(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Body() body: CreateExportDto,
  ): Promise<ExportResponse> {
    return this.exportsService.create(auth.userId, body.filter);
  }

  @Get()
  list(@CurrentAuth("session") auth: SessionAuthContext): Promise<ListExportsResponse> {
    return this.exportsService.list(auth.userId);
  }

  @Get(":id")
  get(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
  ): Promise<ExportResponse> {
    return this.exportsService.get(auth.userId, id);
  }

  @Get(":id/download")
  @Header("Content-Type", "application/gzip")
  @Header("Content-Disposition", `attachment; filename="${EXPORT_EVENTS_FILE}"`)
  @Header("Cache-Control", "no-store")
  async download(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
  ): Promise<StreamableFile> {
    const path = await this.exportsService.fileFor(auth.userId, id, EXPORT_EVENTS_FILE);
    return new StreamableFile(createReadStream(path));
  }

  @Get(":id/manifest")
  @Header("Content-Type", "application/json")
  @Header("Content-Disposition", `attachment; filename="${EXPORT_MANIFEST_FILE}"`)
  @Header("Cache-Control", "no-store")
  async manifest(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
  ): Promise<StreamableFile> {
    const path = await this.exportsService.fileFor(auth.userId, id, EXPORT_MANIFEST_FILE);
    return new StreamableFile(createReadStream(path));
  }
}
