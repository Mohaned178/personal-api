import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";
import { AppException, PROBLEM_CONTENT_TYPE, type ProblemDetails } from "./problem";

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const problem = toProblem(exception);
    if (!(exception instanceof HttpException)) {
      // Name only: messages and stacks can carry user data (invariant 6).
      this.logger.error(
        `Unhandled error: ${exception instanceof Error ? exception.name : "unknown"}`,
      );
    }
    response.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
  }
}

export function toProblem(exception: unknown): ProblemDetails {
  if (exception instanceof AppException) {
    return {
      ...exception.extensions,
      type: "about:blank",
      title: exception.message,
      status: exception.getStatus(),
      code: exception.code,
      ...(exception.detail === undefined ? {} : { detail: exception.detail }),
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return {
      type: "about:blank",
      title: HttpStatus[status]?.replaceAll("_", " ").toLowerCase() ?? "error",
      status,
      code: `http.${status}`,
    };
  }
  return {
    type: "about:blank",
    title: "internal server error",
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: "internal.error",
  };
}
