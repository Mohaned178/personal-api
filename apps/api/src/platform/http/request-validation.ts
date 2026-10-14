import { toContractIssues } from "@personal-api/contracts";
import { createZodValidationPipe } from "nestjs-zod";
import { z } from "zod";
import { AppException } from "../errors/problem";

export const REQUEST_INVALID_CODE = "request.invalid";

/**
 * A request body that failed its Zod schema. The `issues` list comes from `toContractIssues`:
 * paths and schema-written messages only, never the rejected value or an unknown key's name
 * (invariant 6). Anything that is not a Zod error is a bug, not a client mistake, so it is left to
 * become a 500.
 */
export function toRequestInvalid(error: unknown): unknown {
  if (!(error instanceof z.core.$ZodError)) return error;
  return new AppException(400, REQUEST_INVALID_CODE, "Request validation failed", undefined, {
    issues: toContractIssues(error.issues),
  });
}

/**
 * The global validation pipe (registered as APP_PIPE). A parameter is validated only when its
 * declared type is a `createZodDto` class, so a route that types its body as a DTO is checked and
 * `@Param`/`@CurrentAuth` are left alone. The DTO import must stay a value import (not
 * `import type`): the class is how the pipe finds the schema at runtime.
 */
export const RequestValidationPipe = createZodValidationPipe({
  createValidationException: toRequestInvalid as (error: unknown) => Error,
});
