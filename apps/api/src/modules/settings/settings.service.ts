import { Injectable } from "@nestjs/common";
import { DEFAULT_TIME_ZONE, type Settings } from "@personal-api/contracts";
import { assertUserScope } from "../../platform/db/tenant-scope";
import { SettingsRepository } from "./settings.repository";

@Injectable()
export class SettingsService {
  constructor(private readonly repository: SettingsRepository) {}

  async get(userId: string): Promise<Settings> {
    assertUserScope(userId);
    return { timeZone: (await this.repository.getTimeZone(userId)) ?? DEFAULT_TIME_ZONE };
  }

  async update(userId: string, settings: Settings): Promise<Settings> {
    assertUserScope(userId);
    const timeZone = await this.repository.setTimeZone(userId, settings.timeZone);
    return { timeZone: timeZone ?? DEFAULT_TIME_ZONE };
  }
}
