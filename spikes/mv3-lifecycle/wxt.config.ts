import { defineConfig } from "wxt";

// Spike A (M0-10) prototype. Same four permissions as the shipped extension and nothing else:
// no host permissions, no content scripts. Capture runs on chrome.tabs / windows / idle only.
export default defineConfig({
  manifest: {
    name: "Personal API: MV3 lifecycle spike",
    description: "Throwaway prototype for Spike A (M0-10). Not for real use.",
    permissions: ["tabs", "idle", "storage", "alarms"],
  },
});
