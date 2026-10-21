// M9-02 the "Time's up" page: where a tab on a site with a used-up daily limit is sent. It is an
// extension page, not a content script, so nothing runs in the site. The address carries the limit
// id and nothing else; everything shown comes from the limits stored on this device, and the page
// the user came from stays in the tab's own history ("Go back" and "5 more minutes" use it), so no
// URL is stored by the extension.

import { browser } from "wxt/browser";
import { readLimitStatuses, snoozeLimit } from "../../lib/limits/service";
import { formatDuration } from "../../lib/today";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Time's up page is missing #${id}`);
  return element as T;
}

const title = byId<HTMLElement>("title");
const summary = byId<HTMLElement>("summary");
const note = byId<HTMLElement>("note");
const snooze = byId<HTMLButtonElement>("snooze");
const back = byId<HTMLButtonElement>("back");
const close = byId<HTMLButtonElement>("close");

const limitId = new URLSearchParams(window.location.search).get("l");
const storage = browser.storage.local;

/** The page before this one, or the site's front page when there is none (a tab opened on it). */
let fallbackUrl: string | null = null;

function goBack(): void {
  if (window.history.length > 1) window.history.back();
  else if (fallbackUrl !== null) window.location.replace(fallbackUrl);
}

async function render(): Promise<void> {
  const statuses = await readLimitStatuses({ storage, now: Date.now, readOpen: async () => null });
  const status = statuses.find((candidate) => candidate.id === limitId);
  snooze.hidden = true;
  back.hidden = true;

  if (status === undefined) {
    title.textContent = "No limit here";
    summary.textContent = "This limit is no longer set.";
    back.hidden = false;
    return;
  }
  const apex = status.pattern.startsWith("*.") ? status.pattern.slice(2) : status.pattern;
  fallbackUrl = `https://${apex}/`;

  if (!status.reached) {
    title.textContent = "You have time left";
    summary.textContent = `${formatDuration(status.leftMs)} left on ${status.pattern} today.`;
    back.hidden = false;
    return;
  }
  title.textContent = "Time's up";
  summary.textContent = `You have used your ${formatDuration(status.limitMs)} on ${status.pattern} today.`;
  if (status.strict) {
    note.textContent = "Strict mode is on: there is no more time until midnight.";
    note.hidden = false;
  } else {
    snooze.hidden = false;
  }
}

snooze.addEventListener("click", () => {
  if (limitId === null) return;
  snooze.disabled = true;
  void snoozeLimit({ storage, now: Date.now }, limitId).then((result) => {
    if (result === "snoozed") {
      goBack();
      return;
    }
    snooze.disabled = false;
    void render();
  });
});

back.addEventListener("click", goBack);

close.addEventListener("click", () => {
  void browser.tabs.getCurrent().then((tab) => {
    if (tab?.id !== undefined) void browser.tabs.remove(tab.id);
  });
});

void render();
