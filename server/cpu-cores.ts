import os from "os";

/**
 * How many things the app does at once wherever it can: one per CPU core of
 * the computer it runs on — never a number of our own (never slow the app
 * down: .claude/rules/outside-sources.md). "Download all" works on this many songs at once (the
 * page learns it from GET /api/settings: it may be on a phone, whose own count
 * says nothing about this computer); the Save to folder's tags are read, and
 * a long Spotify playlist's pages fetched, this many at a time.
 */
export function cpuCores(): number {
  return Math.max(1, os.availableParallelism());
}

/**
 * Runs `fn` on every item, `atOnce` at a time (one per CPU core unless told
 * otherwise), each next item started the moment one is done. The results come
 * back in the items' order.
 */
export async function mapAtOnce<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  atOnce = cpuCores(),
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  const width = Math.min(Math.max(1, Math.floor(atOnce) || 1), items.length);
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
