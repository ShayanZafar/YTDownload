/**
 * Which addresses are YouTube videos, and their ids. Pure (no network, no
 * Node APIs): the server checks links with it, and the page uses the very
 * same rules to spot a YouTube link in copied text.
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

// A playlist id ("PL…", "OLAK5uy_…" for an album, "UU…" for a channel's uploads).
const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{2,64}$/;

/**
 * The playlist a YouTube link is for: `list=` on youtube.com/playlist,
 * /watch (a video played in a playlist) or youtu.be — or null.
 */
export function extractPlaylistId(rawUrl: string): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!YOUTUBE_HOSTS.has(parsed.hostname)) return null;
  const list = parsed.searchParams.get("list");
  return list && PLAYLIST_ID_RE.test(list) ? list : null;
}

/**
 * A YouTube playlist link to open in the playlist panel: one for the playlist
 * itself (youtube.com/playlist?list=…), with no video of its own. A video
 * played in a playlist (watch?v=…&list=…) opens the video.
 */
export function isYouTubePlaylistLink(rawUrl: string): boolean {
  return extractPlaylistId(rawUrl) !== null && extractVideoId(rawUrl) === null;
}
