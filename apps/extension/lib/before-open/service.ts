// M9-05 "Pause before opening": when a tab goes to a site the user picked, it moves to the
// extension's pause page first. The page counts down, then offers "Continue" or "Close this tab".
//
// The extension never holds the address the user was opening. "Continue" goes back in the tab's
// own history (the browser keeps it, as for the "Time's up" page), so the full page opens again,
// and the pause page's own address carries only the pick id. What is stored is the picked patterns
// and a per-tab "allowed" marker with the pick id (state.ts). Navigating inside a picked site, or
// pressing Continue, does not pause again; leaving the site clears the marker.
//
// No content script, no new permission: the pause starts when the browser reports the new address,
// so the site's page may flash for a moment first. Private windows are never touched. If anything
// fails the tab is left alone: this is a speed bump the user chose, not a privacy gate.

import { domainMatches } from "@personal-api/rules";
import { sanitizeUrl } from "../sanitize-url";
import { allowedKey, type BeforeOpenConfig, type PickedSite, readConfig } from "./state";

/** The pick that covers a page's domain, or null. */
export function matchPick(config: BeforeOpenConfig, url: string | undefined): PickedSite | null {
  const page = sanitizeUrl(url);
  if (page === null) return null;
  return config.sites.find((site) => domainMatches(site.pattern, page.domain)) ?? null;
}

export interface BeforeOpenDeps {
  local: { get(keys: string | string[]): Promise<Record<string, unknown>> };
  session: {
    get(keys: string | string[]): Promise<Record<string, unknown>>;
    remove(keys: string | string[]): Promise<void>;
  };
  tabs: { update(tabId: number, properties: { url: string }): Promise<unknown> };
  /** The extension page for a pick. Carries the pick id and nothing else. */
  pageUrl(pickId: string): string;
}

export interface BeforeOpenService {
  /** For `tabs.onUpdated`. Never rejects. */
  onTabUpdated(
    tabId: number,
    changeInfo: { url?: string },
    tab: { incognito?: boolean },
  ): Promise<void>;
  /** For `tabs.onRemoved`. Never rejects. */
  onTabRemoved(tabId: number): Promise<void>;
}

export function createBeforeOpenService(deps: BeforeOpenDeps): BeforeOpenService {
  async function onTabUpdated(
    tabId: number,
    changeInfo: { url?: string },
    tab: { incognito?: boolean },
  ): Promise<void> {
    if (changeInfo.url === undefined) return;
    try {
      // Anything other than the boolean `false` is treated as private (fail closed).
      if (tab.incognito !== false) return;
      const config = await readConfig(deps.local);
      const pick = matchPick(config, changeInfo.url);
      const key = allowedKey(tabId);
      if (pick === null) {
        // Left the picked site (or went to a page that is not a web page): the next visit pauses.
        await deps.session.remove(key);
        return;
      }
      if ((await deps.session.get(key))[key] === pick.id) return;
      await deps.tabs.update(tabId, { url: deps.pageUrl(pick.id) });
    } catch {
      // The tab is left alone.
    }
  }

  async function onTabRemoved(tabId: number): Promise<void> {
    try {
      await deps.session.remove(allowedKey(tabId));
    } catch {
      // Session storage is cleared by a browser restart anyway.
    }
  }

  return { onTabUpdated, onTabRemoved };
}
