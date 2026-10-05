import { useCallback, useEffect, useRef, useState } from "react";
import {
  canReadClipboard,
  clipboardPermission,
  findCopiedLink,
  type CopiedLink,
} from "@/lib/clipboard";

// The links opened or dismissed since something else was copied (their keys),
// remembered when storage allows.
const HANDLED_KEY = "copied-links-handled";
const MAX_HANDLED = 20;

function storedHandled(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(HANDLED_KEY) ?? "[]");
    return Array.isArray(saved)
      ? saved.filter((key): key is string => typeof key === "string").slice(-MAX_HANDLED)
      : [];
  } catch {
    return [];
  }
}

function storeHandled(keys: string[]) {
  try {
    if (keys.length > 0) localStorage.setItem(HANDLED_KEY, JSON.stringify(keys));
    else localStorage.removeItem(HANDLED_KEY);
  } catch {
    // Not remembered; it still applies until the page is reloaded.
  }
}

/**
 * A YouTube or Spotify link you've copied, to suggest under the main box —
 * only where the browser lets the page look at the clipboard without asking
 * (Chrome and Edge, once you've allowed it; see `lib/clipboard.ts`), so it
 * never makes the browser ask. It looks when the page opens or comes to the
 * front, and when `check()` is called (the empty box got focus). A link that
 * was opened or dismissed (`handle()`) isn't suggested again until something
 * else is copied. Nothing read here leaves the page.
 */
export function useClipboardLink() {
  const [link, setLink] = useState<CopiedLink | null>(null);
  // May the page look unasked? Then the box can suggest a link.
  const [canSuggest, setCanSuggest] = useState(false);
  const handled = useRef<string[]>([]);
  const reading = useRef(false);
  const lookAgain = useRef(false);

  const look = useCallback(async () => {
    try {
      if ((await clipboardPermission())?.state !== "granted") {
        setCanSuggest(false);
        setLink(null);
        return;
      }
      setCanSuggest(true);
      const found = findCopiedLink(await navigator.clipboard.readText()) ?? null;
      if (found && handled.current.includes(found.key)) {
        setLink(null);
        return;
      }
      // Something else is copied now: the links handled before may be suggested again.
      if (handled.current.length > 0) {
        handled.current = [];
        storeHandled([]);
      }
      setLink(found);
    } catch {
      // Not readable just now (the page isn't focused yet, say): it looks again later.
    }
  }, []);

  const check = useCallback(async () => {
    if (!canReadClipboard() || document.visibilityState !== "visible") return;
    // One look at a time; asked again meanwhile, it looks once more afterwards.
    if (reading.current) {
      lookAgain.current = true;
      return;
    }
    reading.current = true;
    try {
      do {
        lookAgain.current = false;
        await look();
      } while (lookAgain.current);
    } finally {
      reading.current = false;
    }
  }, [look]);

  useEffect(() => {
    handled.current = storedHandled();
    const onFocus = () => void check();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check]);

  /** This link was opened or dismissed: not suggested again until something else is copied. */
  const handle = useCallback((key: string) => {
    handled.current = [...handled.current.filter((k) => k !== key), key].slice(-MAX_HANDLED);
    storeHandled(handled.current);
    setLink((current) => (current?.key === key ? null : current));
  }, []);

  return { link, canSuggest, check, handle };
}
