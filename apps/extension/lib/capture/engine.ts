import type { CaptureDeps, CaptureEngine } from "./types";

/** Thrown by the M2-04 stubs until the capture engine exists. */
export class CaptureNotImplementedError extends Error {
  constructor(what: string) {
    super(`M2-04 capture engine: ${what} not implemented`);
    this.name = "CaptureNotImplementedError";
  }
}

export function createCaptureEngine(_deps: CaptureDeps): CaptureEngine {
  throw new CaptureNotImplementedError("createCaptureEngine");
}
