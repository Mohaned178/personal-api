import { listIntegrations } from "@/lib/integrations";
import { listRules } from "@/lib/rules";

/**
 * The setup wizard (M8-02) shows once per browser: finishing or skipping sets this flag. It holds
 * no account data. Storage can be missing or throw (private windows, blocked site data), and then
 * the wizard counts as done, so a broken flag never traps the user in it.
 */
const WELCOME_DONE_KEY = "personal-api.welcome-done";

export function isWelcomeDone(): boolean {
  try {
    return window.localStorage.getItem(WELCOME_DONE_KEY) === "1";
  } catch {
    return true;
  }
}

export function markWelcomeDone(): void {
  try {
    window.localStorage.setItem(WELCOME_DONE_KEY, "1");
  } catch {
    // Nothing to keep: the wizard just shows again on the next login.
  }
}

/**
 * True while the user has no active integration or no rule. Any failure answers false: the home
 * page is the safe place to land, never a loop through the wizard.
 */
export async function needsWelcome(): Promise<boolean> {
  try {
    const [integrations, rules] = await Promise.all([listIntegrations(), listRules()]);
    return !integrations.some((i) => i.status === "active") || rules.rules.length === 0;
  } catch {
    return false;
  }
}
