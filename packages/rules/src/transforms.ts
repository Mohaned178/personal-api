import type { RuleAction } from "@personal-api/contracts";

const DATA_PREFIX = "data.";

/** What the transforms have noted besides changing the data. */
export interface TransformState {
  keepQuery: boolean;
}

/**
 * Keeps the first `segments` path segments: `/a/b/c` with 2 is `/a/b`, with 0 is `/` (a path is
 * required, so "none" is the root). A path with fewer segments is returned as it is, so applying
 * it twice gives the same result.
 */
export function coarsenPath(path: string, segments: number): string {
  return `/${path
    .split("/")
    .slice(1, 1 + segments)
    .join("/")}`;
}

/**
 * Applies one collect-stage transform to `data` in place (the caller passes its own copy).
 * `allow`, `drop` and the process-stage actions are ignored here. An action this engine does not
 * know throws, so the caller fails closed.
 */
export function applyTransform(
  action: RuleAction,
  data: Record<string, unknown>,
  state: TransformState,
): void {
  switch (action.action) {
    case "redact": {
      const key = action.field.slice(DATA_PREFIX.length);
      if (action.field.startsWith(DATA_PREFIX) && Object.hasOwn(data, key)) delete data[key];
      return;
    }
    case "coarsen":
      if (typeof data.path === "string") data.path = coarsenPath(data.path, action.segments);
      return;
    case "keep_query":
      state.keepQuery = true;
      return;
    case "allow":
    case "drop":
    case "tag":
    case "set_retention":
      return;
    default:
      throw new Error("unknown action");
  }
}
