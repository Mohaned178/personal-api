import { pairRequestSchema } from "@personal-api/contracts";
import { createZodDto } from "nestjs-zod";

// Keep this as a value import in the controller: the global pipe finds the schema through the class.
export class PairDto extends createZodDto(pairRequestSchema) {}
