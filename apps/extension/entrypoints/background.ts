import { defineBackground } from "wxt/utils/define-background";

// MV3 service worker. It can be killed at any time, so listeners are registered here at top level
// and state lives in IndexedDB or chrome.storage. No listeners yet (M2 adds them).
export default defineBackground(() => {});
