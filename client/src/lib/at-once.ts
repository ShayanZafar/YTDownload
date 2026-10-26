/**
 * Work on many songs at once — Fill in details, Sanitize Filename and
 * Housekeeping — as many at a time as the app's computer has CPU cores
 * (`cpuCores` in GET /api/settings), the next started the moment one is done.
 */

/**
 * Runs `fn` on every item, `atOnce` at a time, each next one started the
 * moment one is done; stops starting new ones once `signal` is aborted.
 * `onProgress` hears how many are done out of how many: 0 before the first,
 * then after each one, until `signal` is aborted.
 */
export async function eachAtOnce<T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>,
  atOnce: number,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  let next = 0;
  let done = 0;
  onProgress?.(done, items.length);
  const worker = async () => {
    while (next < items.length && !signal?.aborted) {
      await fn(items[next++]);
      done++;
      if (!signal?.aborted) onProgress?.(done, items.length);
    }
  };
  const width = Math.min(Math.max(1, Math.floor(atOnce) || 1), items.length);
  await Promise.all(Array.from({ length: width }, worker));
}
