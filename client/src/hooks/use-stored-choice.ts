import { useState } from "react";

/**
 * A choice between fixed options that this browser remembers (localStorage),
 * e.g. the download format or Link / Search mode. Anything unexpected in
 * storage — or storage being blocked — falls back to the default.
 */
export function useStoredChoice<T extends string>(
  storageKey: string,
  options: readonly T[],
  fallback: T,
) {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved !== null && (options as readonly string[]).includes(saved)
        ? (saved as T)
        : fallback;
    } catch {
      return fallback;
    }
  });

  const choose = (next: T) => {
    setValue(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // Can't remember it — the choice still applies for this visit.
    }
  };

  return [value, choose] as const;
}
