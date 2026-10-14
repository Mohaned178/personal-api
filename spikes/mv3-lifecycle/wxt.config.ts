import { defineConfig } from "wxt";

// Spike A (M0-10) / Spike C (M2-00b) prototype. Same four permissions as the shipped extension and
// nothing else: no host permissions, no content scripts. Capture runs on browser.tabs / windows /
// idle only. Built for Chromium (`wxt build`, service worker) and Firefox
// (`wxt build -b firefox --mv3`, event page).
export default defineConfig({
  manifest: ({ browser }) => ({
    name: "Personal API: MV3 lifecycle spike",
    description: "Throwaway prototype for Spike A (M0-10) and Spike C (M2-00b). Not for real use.",
    permissions: ["tabs", "idle", "storage", "alarms"],
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              // Stable add-on id (not an email address, no personal data): the Firefox e2e harness
              // pins the moz-extension UUID for this id, so a relaunched profile reopens the same
              // IndexedDB. Distinct from the shipped extension's id.
              id: "mv3-lifecycle-spike@personal-api.local",
              strict_min_version: "140.0",
              data_collection_permissions: { required: ["browsingActivity"] },
            },
          },
        }
      : {}),
  }),
});
