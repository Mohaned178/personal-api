import { z } from "zod";

// The API's CSP has no 'unsafe-eval'. Without this, Zod probes `Function("")` and the browser
// logs a CSP violation on every page load; jitless skips the probe and the eval-based fast path.
// Imported first in main.tsx so it runs before any contract schema is built or parsed.
z.config({ jitless: true });
