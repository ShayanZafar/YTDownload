/**
 * Pure helpers for parsing YouTube URLs and picking thumbnails.
 *
 * These have no external side effects (no DB, no HTTP, no spawning),
 * which is what makes them safe to import from unit tests.
 */

// The page spots YouTube links in copied text by the same rules, so they live in shared/.
export { YOUTUBE_HOSTS, extractVideoId } from "@shared/youtube-link";

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
