import { open } from "node:fs/promises";
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import {
  EXPORT_EVENTS_FILE,
  EXPORT_EXPIRED_CODE,
  EXPORT_MANIFEST_FILE,
  type ExportResponse,
  type ListExportsResponse,
} from "@personal-api/contracts";
import type { Response } from "express";
import { AppException, PROBLEM_CONTENT_TYPE } from "../../platform/errors/problem";
import { toProblem } from "../../platform/errors/problem.filter";
import { CurrentAuth, type SessionAuthContext } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { CreateExportDto, ListExportsQueryDto } from "./exports.dto";
import { ExportsService } from "./exports.service";

/** Dashboard routes for data exports. The user is the session's, never the body's or the path's. */
@Controller("v1/exports")
@UseGuards(SessionGuard)
export class ExportsController {
  private readonly logger = new Logger(ExportsController.name);

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
  list(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Query() query: ListExportsQueryDto,
  ): Promise<ListExportsResponse> {
    return this.exportsService.list(auth.userId, query);
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
    return this.stream(await this.exportsService.fileFor(auth.userId, id, EXPORT_EVENTS_FILE));
  }

  @Get(":id/manifest")
  @Header("Content-Type", "application/json")
  @Header("Content-Disposition", `attachment; filename="${EXPORT_MANIFEST_FILE}"`)
  @Header("Cache-Control", "no-store")
  async manifest(
    @CurrentAuth("session") auth: SessionAuthContext,
    @Param("id") id: string,
  ): Promise<StreamableFile> {
    return this.stream(await this.exportsService.fileFor(auth.userId, id, EXPORT_MANIFEST_FILE));
  }

  /**
   * The file is opened here, not lazily by the response: the service checked that it exists, and
   * the cleanup job can remove it before the response opens it. A file that went in between is a
   * 410. Any other failure to open it is a 500 whose message (it names the path) is never sent or
   * logged (invariant 6); a read error after the headers went out just cuts the connection.
   */
  private async stream(path: string): Promise<StreamableFile> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AppException(410, EXPORT_EXPIRED_CODE, "The export has expired");
      }
      throw error;
    }
    return new StreamableFile(handle.createReadStream())
      .setErrorLogger((error: Error) => this.logger.error(`Export download failed: ${error.name}`))
      .setErrorHandler((error: Error, response: unknown) => {
        // Always the Express response here; Nest types it as a narrower interface.
        const res = response as Response;
        if (res.destroyed) return;
        if (res.headersSent) {
          res.destroy();
          return;
        }
        const problem = toProblem(error);
        res.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
      });
  }
}
