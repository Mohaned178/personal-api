import { defineConfig } from "wxt";

// Only the four permissions the plan allows. The API origin is requested at runtime
// through optional_host_permissions; there are no content scripts and no <all_urls>.
// Targets: `chrome-mv3` (Chrome-family, including Edge) and `firefox-mv3`.
export default defineConfig({
  manifest: ({ browser }) => ({
    name: "Personal API",
    description:
      "Sends browsing events to your self-hosted Personal API, only for sites you allow.",
    permissions: ["tabs", "idle", "storage", "alarms"],
    optional_host_permissions: ["https://*/*", "http://*/*"],
    // Never run in incognito windows, even if the user allows it (invariant 3).
    incognito: "not_allowed",
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              // A stable add-on id, not an email address. It is not a secret.
              id: "personal-api@personal-api.local",
              // 140 is the first Firefox that understands data_collection_permissions.
              strict_min_version: "140.0",
              // The extension collects browsing activity (visited sites the user's rules allow) and
              // sends it only to the server the user configures.
              data_collection_permissions: { required: ["browsingActivity"] },
            },
          },
        }
      : {}),
  }),
});
