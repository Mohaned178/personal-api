import { HttpException } from "@nestjs/common";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** RFC 9457 body. `code` is the stable, documented identifier clients branch on. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  [extension: string]: unknown;
}

/** Throw this for expected failures. `code` looks like `ingest.payload_invalid`. */
export class AppException extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    title: string,
    readonly detail?: string,
    readonly extensions: Record<string, unknown> = {},
  ) {
    super(title, status);
  }
}
