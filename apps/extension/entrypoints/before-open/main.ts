// M9-05 the pause page: where a tab on a site the user picked waits before the site opens. It is an
// extension page, not a content script. Its address carries the pick id and nothing else; the page
// the user was opening stays in the tab's own history ("Continue" goes back to it), so the extension
// stores no URL. "Continue" first marks this tab as allowed on the pick, so the site opens without
// another pause (lib/before-open/service.ts).

import { browser } from "wxt/browser";
import { secondsLeft } from "../../lib/before-open/countdown";
import { allowedKey, readConfig } from "../../lib/before-open/state";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Pause page is missing #${id}`);
  return element as T;
}

const title = byId<HTMLElement>("title");
const summary = byId<HTMLElement>("summary");
const proceed = byId<HTMLButtonElement>("continue");
const close = byId<HTMLButtonElement>("close");

const pickId = new URLSearchParams(window.location.search).get("p");

/** The site's front page, for a tab whose history has nothing before this page. */
let fallbackUrl: string | null = null;

function goBack(): void {
  if (window.history.length > 1) window.history.back();
  else if (fallbackUrl !== null) window.location.replace(fallbackUrl);
}

async function render(): Promise<void> {
  const config = await readConfig(browser.storage.local);
  const pick = config.sites.find((site) => site.id === pickId);
  if (pick === undefined) {
    title.textContent = "No pause here";
    summary.textContent = "This site is no longer on your list.";
    return;
  }
  const apex = pick.pattern.startsWith("*.") ? pick.pattern.slice(2) : pick.pattern;
  fallbackUrl = `https://${apex}/`;
  summary.textContent = `You asked for a pause before opening ${pick.pattern}.`;
  proceed.hidden = false;

  const startedAt = Date.now();
  const tick = (): void => {
    const left = secondsLeft(startedAt, Date.now(), config.seconds);
    proceed.disabled = left > 0;
    proceed.textContent = left > 0 ? `Continue (${left})` : "Continue";
    if (left > 0) window.setTimeout(tick, 250);
  };
  tick();

  proceed.addEventListener("click", () => {
    proceed.disabled = true;
    void browser.tabs.getCurrent().then(async (tab) => {
      if (tab?.id !== undefined) {
        await browser.storage.session.set({ [allowedKey(tab.id)]: pick.id });
      }
      goBack();
    });
  });
}

close.addEventListener("click", () => {
  void browser.tabs.getCurrent().then((tab) => {
    if (tab?.id !== undefined) void browser.tabs.remove(tab.id);
  });
});

void render();
