import { useEffect, useLayoutEffect, useRef } from "react";
import { askAgainAt } from "@/lib/playlist-more";

/**
 * The longest a timer waits before looking at the clock again: a computer
 * asleep (a laptop closed overnight) stops timers, not the clock.
 */
const LOOK_AGAIN_MS = 60_000;

/**
 * Calls `ask` once `retryAt` (an ISO time) has come — on time while the page
 * is open, and as soon as it's shown again after a sleep. `answer` changes
 * with every answer to the last ask (its time), so each one is looked at
 * afresh (`askAgainAt()`: one that brings the same `retryAt` back is asked
 * about again a minute later, not at once). No `retryAt`, or a new one,
 * cancels the wait.
 */
export function useAskAgainAt(retryAt: string | undefined, answer: string, ask: () => void) {
  const latestAsk = useRef(ask);
  useLayoutEffect(() => {
    latestAsk.current = ask;
  });
  // The retryAt last asked about.
  const askedAbout = useRef<string | undefined>(undefined);

  useEffect(() => {
    const due = askAgainAt(retryAt, askedAbout.current, Date.now());
    if (due === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let asked = false;
    const check = () => {
      clearTimeout(timer);
      if (asked) return;
      const wait = due - Date.now();
      if (wait > 0) {
        timer = setTimeout(check, Math.min(wait, LOOK_AGAIN_MS));
        return;
      }
      asked = true;
      askedAbout.current = retryAt;
      latestAsk.current();
    };
    const onShown = () => {
      if (document.visibilityState === "visible") check();
    };
    check();
    document.addEventListener("visibilitychange", onShown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onShown);
    };
  }, [retryAt, answer]);
}
