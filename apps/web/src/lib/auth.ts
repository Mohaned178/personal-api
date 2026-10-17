import { type SetupStatusResponse, setupStatusResponseSchema } from "@personal-api/contracts";

/**
 * Dashboard auth calls. Same-origin fetches with the session cookie; nothing here logs, and no
 * request or response body is kept beyond what the caller needs.
 */
export type SetupStatus = SetupStatusResponse;

/** Any failure (401, 5xx, network) counts as signed out, so a broken check never opens a page. */
export async function fetchIsAuthenticated(): Promise<boolean> {
  try {
    const res = await fetch("/v1/me", { credentials: "same-origin" });
    return res.ok;
  } catch {
    return false;
  }
}

/** `null` means unknown; callers treat it as "not open" and "no setup", never the other way. */
export async function fetchSetupStatus(): Promise<SetupStatus | null> {
  try {
    const res = await fetch("/v1/setup/status", { credentials: "same-origin" });
    if (!res.ok) return null;
    const parsed = setupStatusResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function post(path: string, body: Record<string, string>): Promise<Response | null> {
  try {
    return await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

export type AuthResult = { ok: true } | { ok: false; message: string };

export async function signIn(email: string, password: string): Promise<AuthResult> {
  const res = await post("/api/auth/sign-in/email", { email, password });
  if (res?.ok) return { ok: true };
  return { ok: false, message: res ? "Invalid email or password." : "Could not reach the server." };
}

export async function signUp(name: string, email: string, password: string): Promise<AuthResult> {
  const res = await post("/api/auth/sign-up/email", { name, email, password });
  if (res?.ok) return { ok: true };
  if (!res) return { ok: false, message: "Could not reach the server." };
  if (res.status === 403) return { ok: false, message: "Signups are disabled." };
  return { ok: false, message: "Could not create the account." };
}

export async function signOut(): Promise<void> {
  await post("/api/auth/sign-out", {});
}
