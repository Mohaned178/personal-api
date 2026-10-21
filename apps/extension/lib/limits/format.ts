// M9-02 how the popup and the "Time's up" page word a limit. Pure.

import { formatDuration } from "../today";
import type { LimitStatus } from "./evaluate";

/** "25 min left", or "Limit reached" once the allowance is used up. */
export function describeLimit(status: LimitStatus): string {
  return status.reached ? "Limit reached" : `${formatDuration(status.leftMs)} left`;
}
