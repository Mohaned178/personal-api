import { deleteEventsRequestSchema, listEventsQuerySchema } from "@personal-api/contracts";
import { createZodDto } from "nestjs-zod";

// Keep these as value imports in the controller: the global pipe finds the schema through the class.
export class ListEventsQueryDto extends createZodDto(listEventsQuerySchema) {}
export class DeleteEventsDto extends createZodDto(deleteEventsRequestSchema) {}
