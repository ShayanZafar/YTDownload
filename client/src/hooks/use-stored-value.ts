import { useState } from "react";

/**
 * A piece of text this browser remembers (localStorage), e.g. the last Spotify
 * playlist opened. null when there's none — or when storage is blocked, in
 * which case it's simply not remembered.
 */
export function useStoredValue(storageKey: string) {
  const [value, setValue] = useState<string | null>(() => {
    try {
      return localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  });

  const change = (next: string | null) => {
    setValue(next);
    try {
      if (next === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, next);
    } catch {
      // Can't remember it — it still applies for this visit.
    }
  };

  return [value, change] as const;
}
