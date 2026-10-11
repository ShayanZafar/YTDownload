import type { LyricLine } from "@shared/schema";

/**
 * Lines show this much before their time: people read a line just before
 * it's sung, and the page hears of the song's time a few times a second.
 */
export const LYRICS_LEAD_SECONDS = 0.25;

/** Which line is being sung at `time` (seconds): the last one that has started, or -1. */
export function currentLine(lines: readonly LyricLine[], time: number): number {
  const at = time + LYRICS_LEAD_SECONDS;
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].time <= at) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}
