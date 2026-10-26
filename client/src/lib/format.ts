import { formatDistanceToNow } from "date-fns";
import { clock } from "@shared/clock";
import type { PlaylistSource } from "@shared/schema";
import { isYouTubePlaylistLink } from "@shared/youtube-link";

/** Seconds as a clock: 19 → "0:19", 369 → "6:09", 3723 → "1:02:03". */
export const formatDuration = clock;

/** Human-readable size: 2_457_600 → "2.3 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
 * A spotify.link short link (what the Spotify app's Share button copies on a
 * phone): the server opens it to find out whether it's a song, a playlist or
 * an album.
 */
export function isSpotifyShortLink(input: string): boolean {
  return /^(https?:\/\/)?spotify\.(app\.)?link\/[A-Za-z0-9_-]+\/?([?#]\S*)?$/i.test(input.trim());
}

/**
 * A Spotify playlist or album link: it opens in the playlist panel, which
 * lists the songs to pick from. (The server checks it properly.)
 */
export function isSpotifyPlaylistLink(input: string): boolean {
  const text = input.trim();
  return (
    /^spotify:(playlist|album):[A-Za-z0-9]{22}$/i.test(text) ||
    /^(https?:\/\/)?(open|play)\.spotify\.com\/(intl-[a-z-]+\/)?(embed\/)?(playlist|album)\/[A-Za-z0-9]{22}([/?#]|$)/i.test(
      text,
    )
  );
}

/**
 * A link that opens in the playlist panel: a Spotify playlist or album, or a
 * YouTube playlist (youtube.com/playlist?list=…, not a video played in one).
 * Returns where it's from, or undefined for anything else.
 */
export function playlistSourceOf(input: string): PlaylistSource | undefined {
  if (isSpotifyPlaylistLink(input)) return "spotify";
  const link = asLink(input);
  return link && isYouTubePlaylistLink(link) ? "youtube" : undefined;
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
