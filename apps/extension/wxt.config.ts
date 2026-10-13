import { defineConfig } from "wxt";

// Only the four permissions the plan allows. The API origin is requested at runtime
// through optional_host_permissions; there are no content scripts and no <all_urls>.
export default defineConfig({
  manifest: {
    name: "Personal API",
    description:
      "Sends browsing events to your self-hosted Personal API, only for sites you allow.",
    permissions: ["tabs", "idle", "storage", "alarms"],
    optional_host_permissions: ["https://*/*", "http://*/*"],
  },
});
