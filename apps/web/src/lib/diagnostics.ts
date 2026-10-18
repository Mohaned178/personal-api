import type { DiagnosticsResponse } from "@personal-api/contracts";

/**
 * Dashboard call for /v1/diagnostics. Same-origin with the session cookie. Failures throw a
 * generic error (no body or URL in the message), and nothing here logs.
 */
export type { DiagnosticsResponse };

export async function getDiagnostics(hours?: number): Promise<DiagnosticsResponse> {
  const query = hours === undefined ? "" : `?hours=${hours}`;
  const res = await fetch(`/v1/diagnostics${query}`, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Request failed (${res.status}).`);
  return (await res.json()) as DiagnosticsResponse;
}
