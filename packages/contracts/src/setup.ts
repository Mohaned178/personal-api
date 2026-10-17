import { z } from "zod";

/**
 * First-run probe for the dashboard (`GET /v1/setup/status`, public). Two booleans only: no
 * counts, emails or ids. The dashboard treats a response that does not match as "unknown", which
 * hides the setup and signup links rather than showing them.
 */
export const setupStatusResponseSchema = z.strictObject({
  needsSetup: z.boolean(),
  signupOpen: z.boolean(),
});
export type SetupStatusResponse = z.output<typeof setupStatusResponseSchema>;
