import os from "os";

/**
 * How many things the app does at once wherever it can: one per CPU core of
 * the computer it runs on — never a number of our own (see CLAUDE.md: never
 * slow the app down). "Download all" works on this many songs at once (the
 * page learns it from GET /api/settings: it may be on a phone, whose own count
 * says nothing about this computer), and the Save to folder's tags are read
 * this many files at a time.
 */
export function cpuCores(): number {
  return Math.max(1, os.availableParallelism());
}
