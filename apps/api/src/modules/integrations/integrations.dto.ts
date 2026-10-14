import {
  createIntegrationRequestSchema,
  renameIntegrationRequestSchema,
} from "@personal-api/contracts";
import { createZodDto } from "nestjs-zod";

// Keep these as value imports in the controller: the global pipe finds the schema through the class.
export class CreateIntegrationDto extends createZodDto(createIntegrationRequestSchema) {}
export class RenameIntegrationDto extends createZodDto(renameIntegrationRequestSchema) {}
