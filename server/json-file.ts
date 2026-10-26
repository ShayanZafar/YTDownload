import { promises as fs } from "fs";
import path from "path";
import { retryWhenBusy } from "./retry-when-busy";

/**
 * Writes `value` as pretty JSON to `file` through a temp file and a rename, so
 * a crash can't leave half a file; makes its folder if need be. `mode` sets the
 * file's permissions (0o600: only this user can read it).
 */
export async function writeJsonFile(
  file: string,
  value: unknown,
  { mode }: { mode?: number } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", {
    encoding: "utf8",
    ...(mode === undefined ? {} : { mode }),
  });
  await retryWhenBusy(() => fs.rename(tmp, file));
}

/**
 * A queue for one file's changes: each `work` starts once the one before has
 * finished, failed or not, so two changes can't read the same old file and
 * write over each other. Each call answers with its own `work`'s result.
 */
export function oneAtATime(): <T>(work: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  return (work) => {
    const result = queue.then(work, work);
    queue = result.catch(() => {});
    return result;
  };
}
