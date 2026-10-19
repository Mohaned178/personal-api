import {
  endpointInputSchema,
  previewEndpointRequestSchema,
  replaceEndpointRequestSchema,
} from "@personal-api/contracts";
import { createZodDto } from "nestjs-zod";

// Keep these as value imports in the controller: the global pipe finds the schema through the class.
export class EndpointInputDto extends createZodDto(endpointInputSchema) {}
export class ReplaceEndpointDto extends createZodDto(replaceEndpointRequestSchema) {}
export class PreviewEndpointDto extends createZodDto(previewEndpointRequestSchema) {}
