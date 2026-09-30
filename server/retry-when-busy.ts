/**
 * Runs a file operation, retrying for a moment if it fails because the file is
 * busy: on Windows, antivirus or the search indexer can hold a brand-new file
 * briefly, making a rename or delete fail with EPERM, EBUSY or EACCES.
 */
export async function retryWhenBusy<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}
