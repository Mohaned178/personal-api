import { Global, Module } from "@nestjs/common";
import { CLOCK, systemClock } from "./clock";

/** Provides `CLOCK` to every module. Import it once, in the root module. */
@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: systemClock }],
  exports: [CLOCK],
})
export class ClockModule {}
