/**
 * Pure helpers for parsing YouTube URLs and picking thumbnails.
 *
 * These have no external side effects (no DB, no HTTP, no spawning),
 * which is what makes them safe to import from unit tests.
 */

export const YOUTUBE_HOSTS = new Set<string>([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const PATH_VIDEO_ID_RE = /\/(?:shorts|embed|v|live)\/([a-zA-Z0-9_-]{11})/;

/**
 * Extract a YouTube video ID from any common URL shape:
 *   - https://www.youtube.com/watch?v=ID
 *   - https://youtu.be/ID
 *   - https://www.youtube.com/shorts/ID
 *   - https://www.youtube.com/embed/ID
 *   - https://www.youtube.com/v/ID
 *   - https://www.youtube.com/live/ID
 *
 * Returns null if the URL isn't a YouTube link or has no parsable ID.
 */
export function extractVideoId(rawUrl: string): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!YOUTUBE_HOSTS.has(parsed.hostname)) return null;

  if (parsed.hostname === "youtu.be") {
    const id = parsed.pathname.slice(1).split("/")[0];
    return VIDEO_ID_RE.test(id) ? id : null;
  }

  const v = parsed.searchParams.get("v");
  if (v && VIDEO_ID_RE.test(v)) return v;

  const m = parsed.pathname.match(PATH_VIDEO_ID_RE);
  if (m) return m[1];

  return null;
}

export type ThumbnailLike = {
  thumbnail?: string;
  thumbnails?: Array<{ url: string; width?: number }>;
};

/**
 * Pick the highest-resolution thumbnail from a yt-dlp-style info object.
 * Falls back to the single `thumbnail` field, then to an empty string.
 */
export function pickThumbnail(info: ThumbnailLike): string {
  if (info.thumbnails && info.thumbnails.length > 0) {
    const sorted = [...info.thumbnails].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
    return sorted[0].url;
  }
  return info.thumbnail ?? "";
}
