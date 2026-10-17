import { Controller, Get } from "@nestjs/common";
import type { SetupStatusResponse } from "@personal-api/contracts";
import { SignupGate } from "./signup-gate";

/**
 * Public first-run probe for the dashboard. Two booleans only: no counts, emails or ids. Both
 * come from the same signup-gate logic that guards sign-up, and a database error surfaces as a
 * 5xx (the UI treats that as "unknown", never as "open").
 */
@Controller("v1")
export class SetupController {
  constructor(private readonly gate: SignupGate) {}

  @Get("setup/status")
  async status(): Promise<SetupStatusResponse> {
    const [needsSetup, signupOpen] = await Promise.all([
      this.gate.needsSetup(),
      this.gate.isOpen(),
    ]);
    return { needsSetup, signupOpen };
  }
}
