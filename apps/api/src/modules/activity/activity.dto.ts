import { activityDailyQuerySchema, activityDomainsQuerySchema } from "@personal-api/contracts";
import { createZodDto } from "nestjs-zod";

// Keep these as value imports in the controller: the global pipe finds the schema through the class.
export class ActivityDailyQueryDto extends createZodDto(activityDailyQuerySchema) {}
export class ActivityDomainsQueryDto extends createZodDto(activityDomainsQuerySchema) {}
