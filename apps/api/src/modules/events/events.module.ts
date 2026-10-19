import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { KeysModule } from "../keys/keys.module";
import { EventsController } from "./events.controller";
import { EventsRepository } from "./events.repository";
import { EventsService } from "./events.service";

/** Dashboard view of stored events: filtered list with a keyset cursor, get one, delete by ids. */
@Module({
  imports: [AuthModule, KeysModule],
  controllers: [EventsController],
  providers: [EventsRepository, EventsService],
})
export class EventsModule {}
