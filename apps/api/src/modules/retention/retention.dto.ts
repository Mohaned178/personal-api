import { putRetentionRequestSchema } from "@personal-api/contracts";
import { createZodDto } from "nestjs-zod";

// Keep this a value import in the controller: the global pipe finds the schema through the class.
export class PutRetentionDto extends createZodDto(putRetentionRequestSchema) {}
