import type { IncomingMessage, ServerResponse } from "node:http";
import type { Options } from "pino-http";

/**
 * Defense in depth (invariant 6). The serializers below already keep URLs, queries, bodies and
 * headers out of request logs; these paths also censor those fields if anyone logs them by hand.
 * fast-redact wildcards match a single level, so nested depths are listed explicitly. Error
 * `code` fields are deliberately not listed: they are stable identifiers and must stay visible.
 */
const SENSITIVE_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "password",
  "newPassword",
  "currentPassword",
  "token",
  "sessionToken",
  "accessToken",
  "refreshToken",
  "idToken",
  "secret",
  "email",
  "url",
  "domain",
  "body",
  "query",
  "payload",
  // Envelope and request-metadata fields that carry browsing data (invariant 3).
  "data",
  "path",
  "href",
  "referer",
  "referrer",
  // API keys, their hashes and pairing codes (invariant 5).
  "key",
  "apiKey",
  "ingestKey",
  "readKey",
  "keyHash",
  "hash",
  "pairingCode",
];

/** How many levels deep a sensitive key is censored (1 = top level of the logged object). */
const REDACT_DEPTH = 5;

export const REDACT_PATHS: string[] = SENSITIVE_KEYS.flatMap((key) => {
  const root = key.includes("-") ? `["${key}"]` : key;
  const nested = key.includes("-") ? `["${key}"]` : `.${key}`;
  const paths = [root];
  for (let wildcards = 1; wildcards < REDACT_DEPTH; wildcards++) {
    paths.push(`${Array(wildcards).fill("*").join(".")}${nested}`);
  }
  return paths;
});

export const REDACT_CENSOR = "[Redacted]";

export function buildPinoHttpOptions(level: string): Options {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
    serializers: {
      // Deliberately drops url, headers, query, params and body.
      req: (req: IncomingMessage & { id?: unknown }) => ({ id: req.id, method: req.method }),
      res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
    },
  };
}
