import { Injectable } from "@nestjs/common";
import { DEFAULT_TIME_ZONE, type Settings, type TimeZonesResponse } from "@personal-api/contracts";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { SettingsRepository } from "./settings.repository";
import { TimeZoneCatalog } from "./time-zone.catalog";
import { unsupportedTimeZoneRequest } from "./time-zone.errors";

@Injectable()
export class SettingsService {
  constructor(
    private readonly repository: SettingsRepository,
    private readonly zones: TimeZoneCatalog,
  ) {}

  async get(userId: string): Promise<Settings> {
    assertUserScope(userId);
    return { timeZone: (await this.repository.getTimeZone(userId)) ?? DEFAULT_TIME_ZONE };
  }

  /** The contract only knows what Node accepts; the database does the day cutting, so it decides. */
  async update(userId: string, settings: Settings): Promise<Settings> {
    assertUserScope(userId);
    if (!(await this.zones.has(settings.timeZone))) throw unsupportedTimeZoneRequest();
    const timeZone = await this.repository.setTimeZone(userId, settings.timeZone);
    return { timeZone: timeZone ?? DEFAULT_TIME_ZONE };
  }

  async timeZones(): Promise<TimeZonesResponse> {
    return { timeZones: await this.zones.list() };
  }
}
