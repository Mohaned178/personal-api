import { CaptureNotImplementedError } from "./engine";
import type { CaptureEngine, CaptureListenerApi } from "./types";

/**
 * Called synchronously at the top level of the background script. Registers every listener
 * before returning (nothing awaited first), each exactly once. Returns nothing.
 */
export function registerCaptureListeners(_api: CaptureListenerApi, _engine: CaptureEngine): void {
  throw new CaptureNotImplementedError("registerCaptureListeners");
}
