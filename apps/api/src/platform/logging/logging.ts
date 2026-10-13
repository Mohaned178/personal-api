import type { IncomingMessage, ServerResponse } from "node:http";
import type { Options } from "pino-http";

/**
 * Defense in depth (invariant 6). The serializers below already keep URLs, queries, bodies and
 * headers out of request logs; these paths also censor those fields if anyone logs them by hand.
 * fast-redact wildcards match a single level, so nested depths are listed explicitly.
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
];

export const REDACT_PATHS: string[] = SENSITIVE_KEYS.flatMap((key) => {
  const root = key.includes("-") ? `["${key}"]` : key;
  const nested = key.includes("-") ? `["${key}"]` : `.${key}`;
  return [root, `*${nested}`, `*.*${nested}`, `*.*.*${nested}`];
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
