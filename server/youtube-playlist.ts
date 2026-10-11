/**
 * YouTube playlists, for the playlist panel: the videos in a public playlist
 * (or an album on YouTube Music, or a channel's uploads), listed by yt-dlp
 * without opening each video (`--flat-playlist`), like the song search.
 */
import type { SpotifyPlaylist, SpotifyPlaylistTrack } from "@shared/schema";
import { extractPlaylistId } from "@shared/youtube-link";
import { runYtDlpJson } from "./search";
import { YouTubeLimited, playlistCacheKey, youtubeGuard } from "./youtube-limits";

/** The most videos listed: more takes YouTube many seconds, and is more than anyone picks from. */
export const YOUTUBE_PLAYLIST_LIMIT = 500;
const PLAYLIST_TIMEOUT_MS = 90_000;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** A failure with the HTTP status and message to send back to the browser. */
export class YouTubePlaylistError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The playlist a link is for, or an error explaining which links work. */
export function youtubePlaylistIdOf(link: string): string {
  const text = link.trim();
  const id = extractPlaylistId(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  if (!id) {
    throw new YouTubePlaylistError(
      400,
      "Paste a YouTube playlist link — on YouTube, open the playlist and use Share → Copy link.",
    );
  }
  // Watch later and Liked videos need you signed in; mixes are made up as they play.
  if (id === "WL" || id === "LL" || id === "LM") {
    throw new YouTubePlaylistError(
      400,
      "That's one of your own YouTube lists, which only you can see — the app can open public playlists only.",
    );
  }
  if (id.startsWith("RD")) {
    throw new YouTubePlaylistError(
      400,
      "That's a YouTube mix, which YouTube makes up as it plays — the app can open saved playlists only.",
    );
  }
  return id;
}

/** yt-dlp arguments that list a playlist's videos without opening them. */
export function ytDlpPlaylistArgs(id: string): string[] {
  // Only a validated id goes into the address, and "--" ends the options.
  return [
    "--flat-playlist",
    "--dump-single-json",
    "--no-warnings",
    "--playlist-end",
    String(YOUTUBE_PLAYLIST_LIMIT),
    "--",
    `https://www.youtube.com/playlist?list=${id}`,
  ];
}

/** The fields we use from yt-dlp's flat playlist. */
type RawPlaylist = {
  id?: unknown;
  title?: unknown;
  channel?: unknown;
  uploader?: unknown;
  playlist_count?: unknown;
  thumbnails?: unknown;
  entries?: unknown;
};

type RawEntry = {
  id?: unknown;
  title?: unknown;
  duration?: unknown;
  channel?: unknown;
  uploader?: unknown;
};

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

// What YouTube lists in place of a video that's gone or that only some people can see.
const UNAVAILABLE_TITLE = /^\[(private|deleted|unavailable) video\]$/i;

/** Reads a playlist's videos out of yt-dlp's flat listing. */
export function parsePlaylistJson(raw: unknown, id: string): SpotifyPlaylist {
  const info = (raw ?? {}) as RawPlaylist;
  const entries = (Array.isArray(info.entries) ? info.entries : []) as RawEntry[];
  const tracks = entries.flatMap((entry): SpotifyPlaylistTrack[] => {
    const videoId = text(entry?.id);
    const title = text(entry?.title);
    if (!VIDEO_ID_RE.test(videoId) || !title || UNAVAILABLE_TITLE.test(title)) return [];
    return [
      {
        id: videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title,
        artists: text(entry.channel) || text(entry.uploader),
        duration:
          typeof entry.duration === "number" && entry.duration > 0
            ? Math.round(entry.duration)
            : null,
        explicit: false,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      },
    ];
  });

  // The playlist's own picture, else its first video's.
  const thumbnails = (Array.isArray(info.thumbnails) ? info.thumbnails : []) as {
    url?: unknown;
    width?: unknown;
  }[];
  const image =
    thumbnails
      .filter((t) => typeof t?.url === "string")
      .sort((a, b) => Number(a.width ?? 0) - Number(b.width ?? 0))
      .find((t) => Number(t.width ?? 0) >= 300)?.url ??
    (tracks[0] ? `https://i.ytimg.com/vi/${tracks[0].id}/mqdefault.jpg` : null);

  // A channel's playlist is "by" the channel ("Queen Official"); an album's
  // channel is "Album - Artist" on YouTube Music, shown as it is.
  const by = text(info.channel) || text(info.uploader);
  const count = typeof info.playlist_count === "number" ? info.playlist_count : 0;
  return {
    source: "youtube",
    // YouTube Music's albums are playlists whose ids start "OLAK5uy_".
    kind: id.startsWith("OLAK5uy_") ? "album" : "playlist",
    id,
    url: `https://www.youtube.com/playlist?list=${id}`,
    name: text(info.title) || "YouTube playlist",
    by: by || null,
    image: typeof image === "string" ? image : null,
    tracks,
    maybeMore: entries.length >= YOUTUBE_PLAYLIST_LIMIT || count > entries.length,
  };
}

/** What to tell the user when yt-dlp couldn't list the playlist. */
export function playlistFailure(message: string): YouTubePlaylistError {
  if (/does not exist|private|unavailable|not found|404/i.test(message)) {
    return new YouTubePlaylistError(
      404,
      "YouTube doesn't share that playlist — it may be private or deleted, or the link may be wrong.",
    );
  }
  const reason = message.replace(/^ERROR:\s*/, "").replace(/^\[[^\]]+\]\s*/, "");
  return new YouTubePlaylistError(502, `Couldn't read the playlist from YouTube: ${reason}`);
}

/**
 * The videos in a public YouTube playlist (the first 500). Through
 * `youtubeGuard` (youtube-limits.ts): a playlist listed lately comes from its
 * cache, and while YouTube is limiting this computer it throws
 * `YouTubeLimited` instead of asking again.
 */
export async function fetchYouTubePlaylist(
  link: string,
  { stillWanted }: { stillWanted?: () => boolean } = {},
): Promise<SpotifyPlaylist> {
  const id = youtubePlaylistIdOf(link);
  try {
    // Parsed inside, so the cache holds the playlist as sent, not yt-dlp's whole listing.
    return await youtubeGuard.run({
      key: playlistCacheKey(id),
      attempt: async () =>
        parsePlaylistJson(await runYtDlpJson(ytDlpPlaylistArgs(id), PLAYLIST_TIMEOUT_MS), id),
      stillWanted,
    });
  } catch (err) {
    if (err instanceof YouTubeLimited) throw err;
    throw playlistFailure(err instanceof Error ? err.message : String(err));
  }
}
