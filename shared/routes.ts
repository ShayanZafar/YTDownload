import { z } from "zod";
import {
  audioSources,
  downloadSchema,
  folderEntrySchema,
  lyricsSchema,
  folderListingSchema,
  musicLibrarySchema,
  playlistFileSongSchema,
  saveSettingsSchema,
  savedPlaylistFileSchema,
  searchResultSchema,
  songToFindSchema,
  songsInFolderSchema,
  sourceHealthReportSchema,
  spotifyIdSchema,
  spotifyPlaylistSchema,
  spotifyTrackSchema,
} from "./schema";

/**
 * What the download endpoint can produce:
 * - "mp3": converted to a 320 kbps MP3 — plays everywhere (the default).
 * - "original": the source's own audio stream, not re-encoded — smaller and
 *   untouched, saved as .opus (or .m4a when YouTube only has AAC; SoundCloud's
 *   MP3 stays an .mp3).
 */
export const downloadFormats = ["mp3", "original"] as const;
export type DownloadFormat = (typeof downloadFormats)[number];

export const errorSchemas = {
  validation: z.object({
    message: z.string(),
    field: z.string().optional(),
  }),
  notFound: z.object({
    message: z.string(),
  }),
  internal: z.object({
    message: z.string(),
  }),
  /**
   * A `502` for a request YouTube refused because it's limiting this computer
   * (throttled, or a bot check): the usual message — what to do instead — plus
   * which source refused and `limited: true`. Answered at once: the app never
   * waits it out.
   */
  limited: z.object({
    message: z.string(),
    source: z.string(),
    limited: z.literal(true),
  }),
};

export type LimitedError = z.infer<typeof errorSchemas.limited>;

/** A `502`: a source failed (`{ message }`), or YouTube refused (`limited`). */
const upstreamError = z.union([errorSchemas.limited, errorSchemas.internal]);

export const api = {
  downloads: {
    list: {
      method: "GET" as const,
      path: "/api/downloads" as const,
      responses: {
        200: z.array(downloadSchema),
      },
    },
    /** Takes one entry out of the history (the file it downloaded stays). Answers with the entry. */
    remove: {
      method: "DELETE" as const,
      path: "/api/downloads/:id" as const,
      responses: { 200: downloadSchema, 404: errorSchemas.notFound },
    },
    /** Empties the history. Answers with the entries it had, so they can be put back. */
    clear: {
      method: "DELETE" as const,
      path: "/api/downloads" as const,
      responses: { 200: z.array(downloadSchema) },
    },
    /** Puts removed entries back (Undo), in date order; entries still there are skipped. */
    restore: {
      method: "POST" as const,
      path: "/api/downloads/restore" as const,
      input: z.object({ entries: z.array(downloadSchema).max(1000, "Too many entries") }),
      responses: { 200: z.array(downloadSchema) },
    },
  },
  /** A song's lyrics (from LRCLIB), for the music player. */
  lyrics: {
    get: {
      method: "GET" as const,
      path: "/api/lyrics" as const,
      query: z.object({
        title: z.string().trim().min(1, "Which song?").max(300, "That title is too long"),
        artist: z.string().trim().max(300, "That artist is too long").optional(),
        /** The song's length in seconds, to tell recordings apart. */
        duration: z.coerce
          .number()
          .int()
          .positive()
          .max(24 * 60 * 60)
          .optional(),
      }),
      responses: {
        /** null: LRCLIB doesn't have them. */
        200: z.object({ lyrics: lyricsSchema.nullable() }),
        400: errorSchemas.validation,
        502: errorSchemas.internal,
      },
    },
  },
  video: {
    info: {
      method: "POST" as const,
      path: "/api/video/info" as const,
      input: z.object({ url: z.url() }),
      responses: {
        200: z.object({
          title: z.string(),
          thumbnail: z.string(),
          url: z.string(),
        }),
        400: errorSchemas.validation,
        500: errorSchemas.internal,
        502: errorSchemas.limited,
      },
    },
    search: {
      method: "GET" as const,
      path: "/api/search" as const,
      query: z.object({
        q: z
          .string({ error: "Type something to search for" })
          .trim()
          .min(1, "Type something to search for")
          .max(200, "That search is too long"),
        /**
         * "soundcloud": search SoundCloud alone — for a song YouTube refused to
         * hand over. Left out: YouTube, with SoundCloud as its fallback.
         */
        source: z.literal("soundcloud", { error: 'source must be "soundcloud"' }).optional(),
      }),
      responses: {
        200: z.object({
          results: z.array(searchResultSchema),
          /** Which source the results are from (each result says so too). */
          source: z.enum(audioSources),
          /** Present when the search was a Spotify song link: the song it points to. */
          spotify: spotifyTrackSchema.optional(),
        }),
        400: errorSchemas.validation,
        404: errorSchemas.notFound,
        500: errorSchemas.internal,
        502: upstreamError,
      },
    },
    download: {
      method: "GET" as const,
      path: "/api/video/download" as const,
      query: z.object({
        /** A YouTube video's link, or a SoundCloud track's canonical link (a search result's). */
        url: z.string().min(1, "Missing YouTube or SoundCloud link"),
        format: z
          .enum(downloadFormats, { error: 'format must be "mp3" or "original"' })
          .default("mp3"),
        /** File name to save as (without extension); the video's title if left out. */
        name: z.string().max(300, "That file name is too long").optional(),
        /** The Spotify song this is, kept with the history entry. */
        spotifyId: spotifyIdSchema.optional(),
      }),
    },
    /** Download straight into the "Save to" folder (streams progress as JSON lines). */
    save: {
      method: "POST" as const,
      path: "/api/video/save" as const,
      input: z.object({
        url: z.string().min(1, "Missing YouTube or SoundCloud link"),
        format: z
          .enum(downloadFormats, { error: 'format must be "mp3" or "original"' })
          .default("mp3"),
        name: z.string().max(300, "That file name is too long").optional(),
        spotifyId: spotifyIdSchema.optional(),
      }),
    },
  },
  spotify: {
    /**
     * Where a Spotify link leads, as its open.spotify.com address: a
     * spotify.link short link is opened to find out.
     */
    link: {
      method: "GET" as const,
      path: "/api/spotify/link" as const,
      query: z.object({
        link: z
          .string({ error: "Paste a Spotify link" })
          .trim()
          .min(1, "Paste a Spotify link")
          .max(500, "That link is too long"),
      }),
      responses: {
        200: z.object({
          kind: z.enum(["track", "playlist", "album"]),
          url: z.string(),
        }),
        400: errorSchemas.validation,
        404: errorSchemas.notFound,
        502: errorSchemas.internal,
      },
    },
    /** The songs in a public Spotify playlist or album (up to 1,000 songs of a playlist). */
    playlist: {
      method: "GET" as const,
      path: "/api/spotify/playlist" as const,
      query: z.object({
        link: z
          .string({ error: "Paste a Spotify playlist link" })
          .trim()
          .min(1, "Paste a Spotify playlist link")
          .max(500, "That link is too long"),
      }),
      responses: {
        200: spotifyPlaylistSchema,
        400: errorSchemas.validation,
        404: errorSchemas.notFound,
        502: errorSchemas.internal,
      },
    },
  },
  youtube: {
    /** The videos in a public YouTube playlist (the first 500). */
    playlist: {
      method: "GET" as const,
      path: "/api/youtube/playlist" as const,
      query: z.object({
        link: z
          .string({ error: "Paste a YouTube playlist link" })
          .trim()
          .min(1, "Paste a YouTube playlist link")
          .max(500, "That link is too long"),
      }),
      responses: {
        200: spotifyPlaylistSchema,
        400: errorSchemas.validation,
        404: errorSchemas.notFound,
        502: upstreamError,
      },
    },
  },
  health: {
    /**
     * How YouTube, SoundCloud and Spotify have been answering over the last 24
     * hours (the same report as `data/source-health.json`; see
     * server/source-health.ts).
     */
    sources: {
      method: "GET" as const,
      path: "/api/health/sources" as const,
      responses: { 200: sourceHealthReportSchema },
    },
  },
  settings: {
    get: {
      method: "GET" as const,
      path: "/api/settings" as const,
      responses: { 200: saveSettingsSchema },
    },
    update: {
      method: "PUT" as const,
      path: "/api/settings" as const,
      input: z.object({
        /** A folder on this computer, or null to go back to the browser's downloads. */
        saveFolder: z.string().max(1000).nullable(),
      }),
      responses: { 200: saveSettingsSchema, 400: errorSchemas.validation },
    },
  },
  folders: {
    list: {
      method: "GET" as const,
      path: "/api/folders" as const,
      query: z.object({ path: z.string().max(1000).optional() }),
      responses: { 200: folderListingSchema },
    },
    create: {
      method: "POST" as const,
      path: "/api/folders" as const,
      input: z.object({
        parent: z.string().min(1).max(1000),
        name: z.string().min(1, "Give the new folder a name").max(200),
      }),
      responses: { 201: folderEntrySchema },
    },
    /** Which of these songs are already in the "Save to" folder (or its subfolders). */
    songs: {
      method: "POST" as const,
      path: "/api/folders/songs" as const,
      input: z.object({
        songs: z.array(songToFindSchema).max(1000, "That's too many songs to look for at once"),
      }),
      responses: { 200: songsInFolderSchema },
    },
    /**
     * Writes a playlist's songs that are in the "Save to" folder into it as an
     * .m3u8 playlist file, in the playlist's order (see server/playlist-file.ts).
     */
    playlistFile: {
      method: "POST" as const,
      path: "/api/folders/playlist-file" as const,
      input: z.object({
        name: z
          .string()
          .trim()
          .min(1, "The playlist needs a name")
          .max(300, "That playlist name is too long"),
        songs: z
          .array(playlistFileSongSchema)
          .min(1, "The playlist has no songs")
          .max(1000, "That's too many songs for one playlist file"),
      }),
      responses: { 201: savedPlaylistFileSchema },
    },
  },
  /**
   * The music player's songs: those in the "Save to" folder, for a browser on
   * the computer running the app. (A phone plays songs stored on the phone.)
   */
  music: {
    list: {
      method: "GET" as const,
      path: "/api/music" as const,
      responses: { 200: musicLibrarySchema },
    },
    /** A song's file, untouched — range requests work, so the player can seek. */
    audio: { method: "GET" as const, path: "/api/music/:id" as const },
    /** A song converted to FLAC (lossless), for a browser that can't play the file itself. */
    flac: { method: "GET" as const, path: "/api/music/:id/flac" as const },
    /** A song's cover picture, from its tags — 204 when it has none. */
    cover: { method: "GET" as const, path: "/api/music/:id/cover" as const },
  },
};

/**
 * Link for downloading a video's audio in the given format — saved under
 * `name` (made safe with safeFileName on the server) instead of the title,
 * and remembered in the history as `spotifyId` when it's a Spotify song.
 */
export function buildDownloadUrl(
  videoUrl: string,
  format: DownloadFormat = "mp3",
  { name, spotifyId }: { name?: string; spotifyId?: string } = {},
): string {
  const params = new URLSearchParams({ url: videoUrl });
  if (format !== "mp3") params.set("format", format);
  if (name?.trim()) params.set("name", name.trim());
  if (spotifyId) params.set("spotifyId", spotifyId);
  return `${api.video.download.path}?${params}`;
}

export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}
