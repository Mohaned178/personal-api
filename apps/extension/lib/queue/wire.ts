import type { BackgroundDeps, WiredBackground } from "./types";

/**
 * M2-05: everything `entrypoints/background.ts` does, with the browser injected. Called
 * synchronously at the top level of the background. Not implemented.
 */
export function wireBackground(_deps: BackgroundDeps): WiredBackground {
  throw new Error("not implemented");
}
