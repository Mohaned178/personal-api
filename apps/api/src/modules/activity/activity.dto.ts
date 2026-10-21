import {
  activityDailyQuerySchema,
  activityDomainsQuerySchema,
  activityHoursQuerySchema,
  activitySessionsQuerySchema,
  activitySiteQuerySchema,
} from "@personal-api/contracts";
import { createZodDto } from "nestjs-zod";

// Keep these as value imports in the controller: the global pipe finds the schema through the class.
export class ActivityDailyQueryDto extends createZodDto(activityDailyQuerySchema) {}
export class ActivityDomainsQueryDto extends createZodDto(activityDomainsQuerySchema) {}
export class ActivitySiteQueryDto extends createZodDto(activitySiteQuerySchema) {}
export class ActivityHoursQueryDto extends createZodDto(activityHoursQuerySchema) {}
export class ActivitySessionsQueryDto extends createZodDto(activitySessionsQuerySchema) {}
