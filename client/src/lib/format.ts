import { formatDistanceToNow } from "date-fns";

/** Seconds as a clock: 19 → "0:19", 369 → "6:09", 3723 → "1:02:03". */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** A Spotify link: the server looks the song up and searches YouTube for it. */
export function isSpotifyLink(input: string): boolean {
  const text = input.trim();
  return (
    /^spotify:/i.test(text) ||
    /^(https?:\/\/)?(open\.spotify\.com|play\.spotify\.com|spotify\.link)\//i.test(text)
  );
}

/**
 * If what was typed is a link, returns it ready to open ("youtu.be/…" gains
 * "https://"); returns undefined for anything else, which is search text.
 */
export function asLink(input: string): string | undefined {
  const text = input.trim();
  if (!text || /\s/.test(text)) return undefined;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^((www|m|music)\.)?(youtube\.com|youtu\.be)\//i.test(text)) return `https://${text}`;
  return undefined;
}

// The history file is plain JSON on disk, so don't trust its dates blindly:
// an unreadable one shows as "Recently" instead of crashing the list.
export function validDate(iso: string): Date | undefined {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** "3 days ago" (or "Recently" for an unreadable date). */
export function timeAgo(iso: string): string {
  const date = validDate(iso);
  return date ? formatDistanceToNow(date, { addSuffix: true }) : "Recently";
}
